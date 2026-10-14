const fs=require('node:fs');
const path=require('node:path');
const {verifySnapshot}=require('./report-artifact');
const {buildRunPaths,writeImmutableArtifact}=require('./report-run');
const {formatDate}=require('./publisher');
const {buildWeeklyPipelinePaths,loadWeeklyStatus,assertWeeklyReadyEvidence,runWeeklyPublish,redactWeeklyText}=require('./weekly-pipeline');
const {buildSlackBriefing}=require('./slack-briefing');
const {assertReferenceGenerationMode}=require('./report-references');
const {evaluateSummaryQuality}=require('./summary-quality-gate');


function paths(config,meetingDate) {
  const date=formatDate(meetingDate);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid pair meeting date');
  const base=path.resolve(config.env.outputDir);
  const root=path.join(base,'pairs',date);
  return {base,root,date,manifestPath:path.join(root,'manifest.json')};
}

function assertOwned(root,target,kind) {
  const relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error('Pair evidence path escapes root');
  const entries=[root];
  for(const part of relative.split(path.sep).filter(Boolean)) entries.push(path.join(entries.at(-1),part));
  for(const [index,entry] of entries.entries()) {
    const stat=fs.lstatSync(entry);
    if(stat.isSymbolicLink()||stat.uid!==process.getuid()) throw new Error('Pair evidence owner/type mismatch');
    const expected=index===entries.length-1?kind:'directory';
    if(expected==='file'?!stat.isFile():!stat.isDirectory()) throw new Error('Pair evidence is not a '+expected);
  }
}

function assertPrivateDirectory(target) {
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()||stat.uid!==process.getuid()||!stat.isDirectory()||(stat.mode&0o077)!==0) {
    throw new Error('Pair private directory owner/type/mode mismatch');
  }
}

function privateDirectoryTree(root,{apply=false}={}) {
  const pending=[root];
  while(pending.length) {
    const current=pending.pop();
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||stat.uid!==process.getuid()||!stat.isDirectory()) {
      throw new Error('Pair private directory owner/type/mode mismatch');
    }
    if(apply) fs.chmodSync(current,0o700);
    else if((stat.mode&0o077)!==0) throw new Error('Pair private directory owner/type/mode mismatch');
    for(const entry of fs.readdirSync(current,{withFileTypes:true})) {
      const child=path.join(current,entry.name);
      if(entry.isSymbolicLink()) throw new Error('Pair evidence owner/type mismatch');
      if(entry.isDirectory()) pending.push(child);
    }
  }
}

function read(base,file) {
  assertOwned(base,file,'file');
  return fs.readFileSync(file,'utf8');
}

function immutable(file,value) {
  writeImmutableArtifact(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  fs.chmodSync(file,0o600);
}

function variantConfig(config,pair,depth,name='depth'+depth,method) {
  const outputDir=path.join(pair.root,name);
  return {...config,env:{...config.env,reportDepth:depth,outputDir,...(method?{aiGenerationMethod:method}:{}),
    snapshotPath:path.join(outputDir,`report-${pair.date}.snapshot.json`),
    outputPath:path.join(outputDir,`report-${pair.date}.${name}.md`)}};
}

const summaryConfig=(config,pair)=>variantConfig(config,pair,3,'summary','freeform');

function oneLine(value) {
  return redactWeeklyText(value,300).replace(/\s+/g,' ').trim();
}

async function prepareSummary(config,meetingDate,pair,snapshot,dependencies) {
  const {runWeeklyPrepare}=require('../index');
  let outcome;
  try {
    // Report references make freeform fail fast; decide before any AI call.
    assertReferenceGenerationMode(snapshot,'freeform');
    const child=summaryConfig(config,pair);
    // A kill skips the finally below; the private umask keeps directories of a half-made summary from
    // failing the already prepared pair's private-tree checks (publish 2|3, preview, send).
    const previousUmask=process.umask(0o077);
    let generated;
    try {
      fs.mkdirSync(child.env.outputDir,{mode:0o700});
      immutable(child.env.snapshotPath,JSON.stringify(snapshot,null,2)+'\n');
      // One generation only: a rejected summary is never regenerated (issue #25); that week publishes depth2.
      generated=await runWeeklyPrepare(child,meetingDate,{generationMethod:'freeform',
        runCollect:async()=>({snapshot,snapshotPath:child.env.snapshotPath}),
        ...(dependencies.generate?{runGenerate:dependencies.generate}:{}),
      });
    } finally {
      process.umask(previousUmask);
      privateDirectoryTree(pair.root,{apply:true});
    }
    const {state}=generated;
    const gate=evaluateSummaryQuality(read(pair.root,state.reportPath),child);
    const codes=[...new Set(gate.blocking.map(issue=>issue.code))];
    outcome={status:codes.length?'failed':'ready',reason:codes.length?'quality_gate: '+codes.join(','):null,
      reportHash:state.reportHash,generationAttemptId:state.generationAttemptId,pipelineAttemptId:state.pipelineAttemptId,gate};
  } catch(error) {
    const code=error&&error.code;
    const detail=error&&error.weeklyFailure&&error.weeklyFailure.failure.primaryIssueCode;
    outcome={status:code==='REPORT_REFERENCES_REQUIRE_SELECTION'?'skipped':'failed',
      reason:oneLine(`${code||'SUMMARY_FAILED'}${detail&&detail!==code?'/'+detail:''}: ${error&&error.message}`),gate:null};
  }
  const summary={schemaVersion:1,meetingDate:pair.date,snapshotHash:snapshot.contentHash,...outcome};
  let warning=summary.status==='ready'?null:summary.reason;
  try {
    immutable(path.join(pair.root,'summary.json'),summary);
  } catch(error) {
    warning=oneLine(`summary.json not saved: ${error.message}`);
  }
  if(warning) {
    console.log(`[summary][WARN] status=${summary.status} reason=${warning}`);
    try {
      // The wrapper's failure log under OUTPUT_DIR (cron: out/ALERT.log); fallbacks are warnings there,
      // never remote notifications. Deriving it from OUTPUT_DIR keeps test runs out of a real checkout's log.
      const alertLog=dependencies.alertLogPath||path.join(pair.base,'ALERT.log');
      fs.mkdirSync(path.dirname(alertLog),{recursive:true});
      const now=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
      fs.appendFileSync(alertLog,`[WARN] ${now} redmine 요약본 미사용 — ${warning} (depth2로 게시 예정)\n`);
    } catch {
      // Best effort only: the prepared pair stays valid without the alert line.
    }
  }
  return summary;
}

async function prepareWeeklyPair(config,meetingDate,dependencies={}) {
  const {runCollect,runWeeklyPrepare,assertWeeklyProfile}=require('../index');
  assertWeeklyProfile(config,'weekly-prepare');
  const pair=paths(config,meetingDate);
  fs.mkdirSync(pair.base,{recursive:true});
  assertOwned(pair.base,pair.base,'directory');
  const parent=path.dirname(pair.root);
  if(!fs.existsSync(parent)) fs.mkdirSync(parent);
  assertOwned(pair.base,parent,'directory');
  if(fs.existsSync(pair.root)) throw new Error('Weekly pair already exists; preserve it and use a new OUTPUT_DIR for a new attempt');
  fs.mkdirSync(pair.root,{mode:0o700});
  const shared=path.join(pair.root,'source');
  fs.mkdirSync(shared,{mode:0o700});
  const collected=await (dependencies.collect||runCollect)({...config,env:{...config.env,
    reportDepth:3,outputDir:shared,snapshotPath:path.join(shared,'snapshot.json')}},meetingDate);
  privateDirectoryTree(pair.root,{apply:true});
  const snapshot=verifySnapshot(collected.snapshot);
  if(snapshot.status!=='sealed'||snapshot.meetingDate!==pair.date) throw new Error('Paired reports require a sealed snapshot for this meeting');
  const manifest={schemaVersion:1,meetingDate:pair.date,defaultPublishDepth:2,snapshotHash:snapshot.contentHash,variants:{}};
  for(const depth of [3,2]) {
    const child=variantConfig(config,pair,depth);
    fs.mkdirSync(child.env.outputDir,{mode:0o700});
    immutable(child.env.snapshotPath,JSON.stringify(snapshot,null,2)+'\n');
    let generated;
    try {
      generated=await runWeeklyPrepare(child,meetingDate,{
        runCollect:async()=>({snapshot,snapshotPath:child.env.snapshotPath}),
        ...(dependencies.generate?{runGenerate:dependencies.generate}:{}),
      });
    } finally {
      // The weekly pipeline creates attempt/failure directories even when it throws;
      // keep the whole private bundle private so the next stage reports the real cause.
      privateDirectoryTree(pair.root,{apply:true});
    }
    manifest.variants[depth]={reportHash:generated.state.reportHash,
      generationAttemptId:generated.state.generationAttemptId,pipelineAttemptId:generated.state.pipelineAttemptId};
  }
  immutable(pair.manifestPath,manifest);
  const preview=previewWeeklyPair(config,meetingDate);
  immutable(path.join(pair.root,'slack.depth3.json'),preview);
  const summary=await prepareSummary(config,meetingDate,pair,snapshot,dependencies);
  return {...pair,manifest,summary};
}

function verifyVariant(pair,snapshotHash,child,expected,meetingDate,allowedStatuses,generationMethod) {
  assertOwned(pair.root,child.env.outputDir,'directory');
  assertPrivateDirectory(child.env.outputDir);
  const state=loadWeeklyStatus(child.env.outputDir,pair.date);
  if(!state||!allowedStatuses.includes(state.status)) throw new Error('Pair variant needs recovery; inspect its weekly state');
  if(state.snapshotHash!==snapshotHash||state.reportHash!==expected.reportHash
    ||state.reportDepth!==child.env.reportDepth||state.generationAttemptId!==expected.generationAttemptId
    ||state.pipelineAttemptId!==expected.pipelineAttemptId||state.reportPath!==child.env.outputPath
    ||state.snapshotPath!==child.env.snapshotPath) throw new Error('Pair variant evidence mismatch');
  assertWeeklyReadyEvidence(buildWeeklyPipelinePaths(child.env.outputDir,pair.date),state,child,meetingDate,{generationMethod});
  return {config:child,state};
}

function readWeeklyPair(config,meetingDate,{detailOnly=false}={}) {
  const pair=paths(config,meetingDate);
  privateDirectoryTree(pair.root);
  const manifestBytes=read(pair.root,pair.manifestPath);
  const manifest=JSON.parse(manifestBytes);
  if(manifest.schemaVersion!==1||manifest.meetingDate!==pair.date||manifest.defaultPublishDepth!==2
    ||!/^[a-f0-9]{64}$/.test(manifest.snapshotHash)||!manifest.variants
    ||Object.keys(manifest.variants).sort().join(',')!=='2,3') throw new Error('Invalid weekly pair manifest');
  const variants={};
  for(const depth of detailOnly?[3]:[2,3]) {
    const allowedStatuses=detailOnly?['ready','publishing','published','failed']:['ready','published'];
    variants[depth]=verifyVariant(pair,manifest.snapshotHash,variantConfig(config,pair,depth),
      manifest.variants[depth],meetingDate,allowedStatuses);
  }
  if(read(pair.root,pair.manifestPath)!==manifestBytes) throw new Error('Pair manifest changed during verification');
  return {...pair,manifest,variants};
}

function previewWeeklyPair(config,meetingDate) {
  const pair=readWeeklyPair(config,meetingDate,{detailOnly:true});
  const variant=pair.variants[3];
  const run=buildRunPaths(variant.config.env.outputDir,pair.date,variant.state.generationAttemptId);
  assertPrivateDirectory(run.runDir);
  return buildSlackBriefing({meetingDate:pair.date,reportHash:variant.state.reportHash,
    records:JSON.parse(read(pair.root,path.join(run.runDir,'source-records.json'))),
    selection:JSON.parse(read(pair.root,path.join(run.runDir,'source-selection.json'))).selection});
}

function readSummaryRecord(pair) {
  const file=path.join(pair.root,'summary.json');
  try {
    fs.lstatSync(file);
  } catch(error) {
    if(error.code==='ENOENT') return null;
    throw error;
  }
  let record;
  try {
    record=JSON.parse(read(pair.root,file));
  } catch(error) {
    if(!(error instanceof SyntaxError)) throw error;
    throw new Error('Invalid weekly summary record',{cause:error});
  }
  if(!record||record.schemaVersion!==1||record.meetingDate!==pair.date||record.snapshotHash!==pair.manifest.snapshotHash
    ||!['ready','skipped','failed'].includes(record.status)) throw new Error('Invalid weekly summary record');
  return record;
}

// Auto publishes the summary only when it was ready and its evidence still passes the variant checks.
// An unreadable record is not a fallback reason: it hides whether the summary was published, so
// publishWeeklyPair stops every depth for inspection and auto must not claim a depth2 fallback first.
function selectSummary(config,meetingDate,pair) {
  const record=readSummaryRecord(pair);
  if(!record) return {reason:'summary.json is missing'};
  if(record.status!=='ready') return {reason:`summary ${record.status}: ${record.reason}`};
  try {
    return {variant:verifyVariant(pair,record.snapshotHash,summaryConfig(config,pair),record,meetingDate,
      ['ready','published'],'freeform')};
  } catch(error) {
    return {reason:oneLine(error.message)};
  }
}

async function publishWeeklyPair(config,meetingDate,{depth=2,dependencies={}}={}) {
  if(![2,3,'auto'].includes(depth)) throw new Error('Publish depth must be 2 or 3, or auto');
  const pair=readWeeklyPair(config,meetingDate);
  let name=String(depth==='auto'?2:depth);
  let variant=pair.variants[name];
  let generationMethod;
  if(depth==='auto') {
    const summary=selectSummary(config,meetingDate,pair);
    if(summary.variant) ({name,variant,generationMethod}={name:'summary',variant:summary.variant,generationMethod:'freeform'});
    else console.log(`[summary] fallback to depth2: ${summary.reason}`);
  }
  const publishDependencies={...dependencies,generationMethod};
  const receiptValue={schemaVersion:1,meetingDate:pair.date,depth:variant.state.reportDepth,variant:name,
    reportHash:variant.state.reportHash};
  const started=path.join(pair.root,'publication.started.json');
  const completed=path.join(pair.root,'publication.completed.json');
  if(fs.existsSync(completed)) {
    const receipt=JSON.parse(read(pair.root,completed));
    const intent=JSON.parse(read(pair.root,started));
    if(receipt.schemaVersion!==1||receipt.meetingDate!==pair.date
      ||JSON.stringify(receipt)!==JSON.stringify(intent)) throw new Error('Pair publication receipt evidence mismatch');
    // Receipts written before the summary variant carry only their depth.
    if((receipt.variant??String(receipt.depth))!==name||receipt.depth!==variant.state.reportDepth
      ||receipt.reportHash!==variant.state.reportHash
      ||variant.state.status!=='published') throw new Error('Already published; replacing a report requires explicit recovery approval');
    return runWeeklyPublish(variant.config,meetingDate,publishDependencies);
  }
  if(fs.existsSync(started)) throw new Error('Publication needs recovery; inspect the saved attempt before retrying');
  const summaryRecord=readSummaryRecord(pair);
  const summaryState=summaryRecord&&summaryRecord.status==='ready'
    ?loadWeeklyStatus(summaryConfig(config,pair).env.outputDir,pair.date):null;
  if(Object.values(pair.variants).some(value=>value.state.status!=='ready')
    ||(summaryRecord&&summaryRecord.status==='ready'&&(!summaryState||summaryState.status!=='ready'))) {
    throw new Error('Pair publication receipt is missing; recovery required before any replacement');
  }
  const legacy=loadWeeklyStatus(config.env.outputDir,pair.date);
  if(legacy&&['failed','publishing','published'].includes(legacy.status)) throw new Error('An existing publication needs inspection before replacing it');
  immutable(started,receiptValue);
  let result;
  try {
    result=await runWeeklyPublish(variant.config,meetingDate,publishDependencies);
  } finally {
    // The weekly pipeline creates attempt/failure directories; keep the whole private bundle private.
    privateDirectoryTree(pair.root,{apply:true});
  }
  if(result.state.status!=='published') throw new Error('Pair publication did not complete; inspect recovery evidence');
  immutable(completed,receiptValue);
  return result;
}

async function sendWeeklyPair(config,meetingDate,dependencies={}) {
  const {sendSlackBriefing}=require('./slack-delivery');
  const pair=paths(config,meetingDate);
  const briefing=previewWeeklyPair(config,meetingDate);
  const savedBriefingPath=path.join(pair.root,'slack.depth3.json');
  const expectedBriefing=JSON.stringify(briefing,null,2)+'\n';
  const assertSource=()=>{
    const current=readWeeklyPair(config,meetingDate,{detailOnly:true});
    if(current.variants[3].state.reportHash!==briefing.reportHash) throw new Error('Slack source report changed');
    if(read(pair.root,savedBriefingPath)!==expectedBriefing) throw new Error('Saved mobile briefing evidence mismatch');
  };
  return sendSlackBriefing({briefing,deliveryDir:path.join(pair.root,'slack-delivery'),
    channel:config.env.slackBriefingChannelId,token:config.env.slackBotToken,
    approvedIdentity:{teamId:config.env.slackBriefingTeamId,botId:config.env.slackBriefingBotId,
      botUserId:config.env.slackBriefingBotUserId,peerUserId:config.env.slackBriefingPeerUserId},
    fetch:dependencies.fetch,sleep:dependencies.sleep,
    assertSource});
}

module.exports={prepareWeeklyPair,readWeeklyPair,previewWeeklyPair,publishWeeklyPair,sendWeeklyPair};
