const fs=require('node:fs');
const path=require('node:path');
const {verifySnapshot}=require('./report-artifact');
const {buildRunPaths,writeImmutableArtifact}=require('./report-run');
const {formatDate}=require('./publisher');
const {buildWeeklyPipelinePaths,loadWeeklyStatus,assertWeeklyReadyEvidence,runWeeklyPublish}=require('./weekly-pipeline');
const {buildSlackBriefing}=require('./slack-briefing');

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

function read(base,file) {
  assertOwned(base,file,'file');
  return fs.readFileSync(file,'utf8');
}

function immutable(file,value) {
  writeImmutableArtifact(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  fs.chmodSync(file,0o600);
}

function variantConfig(config,pair,depth) {
  const outputDir=path.join(pair.root,'depth'+depth);
  return {...config,env:{...config.env,reportDepth:depth,outputDir,
    snapshotPath:path.join(outputDir,`report-${pair.date}.snapshot.json`),
    outputPath:path.join(outputDir,`report-${pair.date}.depth${depth}.md`)}};
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
  const snapshot=verifySnapshot(collected.snapshot);
  if(snapshot.status!=='sealed'||snapshot.meetingDate!==pair.date) throw new Error('Paired reports require a sealed snapshot for this meeting');
  const manifest={schemaVersion:1,meetingDate:pair.date,defaultPublishDepth:2,snapshotHash:snapshot.contentHash,variants:{}};
  for(const depth of [3,2]) {
    const child=variantConfig(config,pair,depth);
    fs.mkdirSync(child.env.outputDir,{mode:0o700});
    immutable(child.env.snapshotPath,JSON.stringify(snapshot,null,2)+'\n');
    const generated=await runWeeklyPrepare(child,meetingDate,{
      runCollect:async()=>({snapshot,snapshotPath:child.env.snapshotPath}),
      ...(dependencies.generate?{runGenerate:dependencies.generate}:{}),
    });
    manifest.variants[depth]={reportHash:generated.state.reportHash,
      generationAttemptId:generated.state.generationAttemptId,pipelineAttemptId:generated.state.pipelineAttemptId};
  }
  immutable(pair.manifestPath,manifest);
  const preview=previewWeeklyPair(config,meetingDate);
  immutable(path.join(pair.root,'slack.depth3.json'),preview);
  return {...pair,manifest};
}

function readWeeklyPair(config,meetingDate,{detailOnly=false}={}) {
  const pair=paths(config,meetingDate);
  const manifestBytes=read(pair.base,pair.manifestPath);
  const manifest=JSON.parse(manifestBytes);
  if(manifest.schemaVersion!==1||manifest.meetingDate!==pair.date||manifest.defaultPublishDepth!==2
    ||!/^[a-f0-9]{64}$/.test(manifest.snapshotHash)||!manifest.variants
    ||Object.keys(manifest.variants).sort().join(',')!=='2,3') throw new Error('Invalid weekly pair manifest');
  const variants={};
  for(const depth of detailOnly?[3]:[2,3]) {
    const child=variantConfig(config,pair,depth);
    assertOwned(pair.base,child.env.outputDir,'directory');
    const state=loadWeeklyStatus(child.env.outputDir,pair.date);
    const expected=manifest.variants[depth];
    const allowedStatuses=detailOnly?['ready','publishing','published','failed']:['ready','published'];
    if(!state||!allowedStatuses.includes(state.status)) throw new Error('Pair variant needs recovery; inspect its weekly state');
    if(state.snapshotHash!==manifest.snapshotHash||state.reportHash!==expected.reportHash
      ||state.reportDepth!==depth||state.generationAttemptId!==expected.generationAttemptId
      ||state.pipelineAttemptId!==expected.pipelineAttemptId||state.reportPath!==child.env.outputPath
      ||state.snapshotPath!==child.env.snapshotPath) throw new Error('Pair variant evidence mismatch');
    assertWeeklyReadyEvidence(buildWeeklyPipelinePaths(child.env.outputDir,pair.date),state,child,meetingDate);
    variants[depth]={config:child,state};
  }
  if(read(pair.base,pair.manifestPath)!==manifestBytes) throw new Error('Pair manifest changed during verification');
  return {...pair,manifest,variants};
}

function previewWeeklyPair(config,meetingDate) {
  const pair=readWeeklyPair(config,meetingDate,{detailOnly:true});
  const variant=pair.variants[3];
  const run=buildRunPaths(variant.config.env.outputDir,pair.date,variant.state.generationAttemptId);
  return buildSlackBriefing({meetingDate:pair.date,reportHash:variant.state.reportHash,
    records:JSON.parse(read(pair.base,path.join(run.runDir,'source-records.json'))),
    selection:JSON.parse(read(pair.base,path.join(run.runDir,'source-selection.json'))).selection});
}

async function publishWeeklyPair(config,meetingDate,{depth=2,dependencies={}}={}) {
  if(![2,3].includes(depth)) throw new Error('Publish depth must be 2 or 3');
  const pair=readWeeklyPair(config,meetingDate);
  const variant=pair.variants[depth];
  const started=path.join(pair.root,'publication.started.json');
  const completed=path.join(pair.root,'publication.completed.json');
  if(fs.existsSync(completed)) {
    const receipt=JSON.parse(read(pair.base,completed));
    const intent=JSON.parse(read(pair.base,started));
    if(receipt.schemaVersion!==1||receipt.meetingDate!==pair.date
      ||JSON.stringify(receipt)!==JSON.stringify(intent)) throw new Error('Pair publication receipt evidence mismatch');
    if(receipt.depth!==depth||receipt.reportHash!==variant.state.reportHash
      ||variant.state.status!=='published') throw new Error('Already published; replacing a report requires explicit recovery approval');
    return runWeeklyPublish(variant.config,meetingDate,dependencies);
  }
  if(fs.existsSync(started)) throw new Error('Publication needs recovery; inspect the saved attempt before retrying');
  if(Object.values(pair.variants).some(value=>value.state.status!=='ready')) {
    throw new Error('Pair publication receipt is missing; recovery required before any replacement');
  }
  const legacy=loadWeeklyStatus(config.env.outputDir,pair.date);
  if(legacy&&['failed','publishing','published'].includes(legacy.status)) throw new Error('An existing publication needs inspection before replacing it');
  immutable(started,{schemaVersion:1,meetingDate:pair.date,depth,reportHash:variant.state.reportHash});
  const result=await runWeeklyPublish(variant.config,meetingDate,dependencies);
  if(result.state.status!=='published') throw new Error('Pair publication did not complete; inspect recovery evidence');
  immutable(completed,{schemaVersion:1,meetingDate:pair.date,depth,reportHash:variant.state.reportHash});
  return result;
}

async function sendWeeklyPair(config,meetingDate,dependencies={}) {
  const {sendSlackBriefing}=require('./slack-delivery');
  const pair=readWeeklyPair(config,meetingDate,{detailOnly:true});
  const briefing=previewWeeklyPair(config,meetingDate);
  const savedBriefingPath=path.join(pair.root,'slack.depth3.json');
  const expectedBriefing=JSON.stringify(briefing,null,2)+'\n';
  const assertSource=()=>{
    const current=readWeeklyPair(config,meetingDate,{detailOnly:true});
    if(current.variants[3].state.reportHash!==briefing.reportHash) throw new Error('Slack source report changed');
    if(read(pair.base,savedBriefingPath)!==expectedBriefing) throw new Error('Saved mobile briefing evidence mismatch');
  };
  assertSource();
  return sendSlackBriefing({briefing,deliveryDir:path.join(pair.root,'slack-delivery'),
    channel:config.env.slackBriefingChannelId,token:config.env.slackBotToken,
    fetch:dependencies.fetch,sleep:dependencies.sleep,
    assertSource});
}

module.exports={prepareWeeklyPair,readWeeklyPair,previewWeeklyPair,publishWeeklyPair,sendWeeklyPair};
