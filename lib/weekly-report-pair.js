const fs=require('node:fs');
const path=require('node:path');
const {verifySnapshot,buildGenerationStatePath,sha256}=require('./report-artifact');
const {buildRunPaths,writeImmutableArtifact,withGenerationStateLock}=require('./report-run');
const {formatDate}=require('./publisher');
const {buildWeeklyPipelinePaths,loadWeeklyStatus,assertWeeklyReadyEvidence,runWeeklyPublish,runWeeklyPublishRejected,
  redactWeeklyText}=require('./weekly-pipeline');
const {buildSlackBriefing}=require('./slack-briefing');
const {assertReferenceGenerationMode}=require('./report-references');
const {evaluateSummaryQuality}=require('./summary-quality-gate');
const {buildReviewBlock,variantLabel}=require('./review-block');


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

function summaryConfig(config,pair,profile) {
  const child=variantConfig(config,pair,3,'summary','freeform');
  const team=profile===undefined?config.reportFilter?.teamReport?.enabled:profile!==null;
  if(!team) return {...child,env:{...child.env,reportAudience:undefined,aiGenerationScope:'whole'}};
  if(profile&&(profile.schemaVersion!==1||profile.audience!=='team'
    ||typeof profile.highlightEnabled!=='boolean'||!Number.isInteger(profile.highlightMaxLines)||profile.highlightMaxLines<0
    ||!Number.isInteger(profile.advisoryMaxBullets)||profile.advisoryMaxBullets<1)) throw new Error('Invalid summary quality profile');
  return {...child,env:{...child.env,reportAudience:'team',aiGenerationScope:'project'},
    ...(profile?{reportFilter:{...child.reportFilter,leaderHighlight:{...child.reportFilter?.leaderHighlight,
      enabled:profile.highlightEnabled,maxLines:profile.highlightMaxLines}}}:{}),
    depthProfiles:{...child.depthProfiles,3:{...child.depthProfiles?.[3],label:'팀 업무보고',
      advisoryMaxBullets:profile?.advisoryMaxBullets||config.reportFilter?.teamReport?.advisoryMaxBullets||60}}};
}

function oneLine(value,config) {
  return redactWeeklyText(value,300,config).replace(/\s+/g,' ').trim();
}

// The wrapper's failure log under OUTPUT_DIR (cron: out/ALERT.log); these are warnings there, never remote
// notifications. Deriving it from OUTPUT_DIR keeps test runs out of a real checkout's log.
function appendAlert(pair,dependencies,text) {
  try {
    const alertLog=dependencies.alertLogPath||path.join(pair.base,'ALERT.log');
    fs.mkdirSync(path.dirname(alertLog),{recursive:true});
    const now=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
    fs.appendFileSync(alertLog,`[WARN] ${now} ${text}\n`);
  } catch {
    // Best effort only: the alert line never decides the outcome.
  }
}

function fallbackAlertId(receipt,message) {
  return sha256(JSON.stringify([receipt.meetingDate,receipt.depth,receipt.variant,
    receipt.reportHash,receipt.status||null,message]));
}

// The receipt is the pending event; its marker in ALERT.log is the acknowledgement. The existing
// file lock serializes recovery, including a retry after append succeeded but its caller was interrupted.
function recordFallbackAlert(pair,receipt,config,dependencies) {
  const event=receipt.fallbackAlert;
  if(event===undefined) return; // Older receipts did not retain the original fallback reason.
  if(!event||typeof event!=='object'||Array.isArray(event)
    ||Object.keys(event).sort().join(',')!=='id,message'
    ||typeof event.message!=='string'||!event.message||event.message.length>512
    ||/[\x00-\x1f\x7f-\x9f]/.test(event.message)
    ||event.id!==fallbackAlertId(receipt,event.message)) throw new Error('Invalid fallback alert receipt');
  try {
    const alertLog=dependencies.alertLogPath||path.join(pair.base,'ALERT.log');
    fs.mkdirSync(path.dirname(alertLog),{recursive:true});
    withGenerationStateLock(alertLog,()=>{
      const fd=fs.openSync(alertLog,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
      try {
        const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.uid!==process.getuid()) throw new Error('Fallback alert owner/type mismatch');
        const marker=Buffer.from(`[fallback-event:${event.id}]`);
        const chunk=Buffer.alloc(4096);
        let tail=Buffer.alloc(0),position=0,found=false,size;
        while((size=fs.readSync(fd,chunk,0,chunk.length,position))>0) {
          const bytes=Buffer.concat([tail,chunk.subarray(0,size)]);
          if(bytes.includes(marker)) {found=true;break;}
          tail=bytes.subarray(Math.max(0,bytes.length-marker.length+1));
          position+=size;
        }
        if(!found) {
          const length=fs.fstatSync(fd).size;
          const last=Buffer.alloc(1);
          if(length) fs.readSync(fd,last,0,1,length-1);
          const now=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
          const message=redactWeeklyText(event.message,512,config);
          fs.appendFileSync(fd,`${length&&last[0]!==10?'\n':''}[WARN] ${now} ${message} ${marker.toString()}\n`);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
  } catch(error) {
    console.error(`[pair][WARN] fallback alert pending: ${event.id} ${oneLine(error.message,config)}`);
  }
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
      // One generation only: a rejected summary is never regenerated (issue #25); auto selects a retained alternative.
      generated=await runWeeklyPrepare(child,meetingDate,{generationMethod:'freeform',optionalSummary:true,
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
      reason:oneLine(`${code||'SUMMARY_FAILED'}${detail&&detail!==code?'/'+detail:''}: ${error&&error.message}`,config),gate:null};
  }
  const summary={schemaVersion:1,meetingDate:pair.date,snapshotHash:snapshot.contentHash,...outcome};
  let warning=summary.status==='ready'?null:summary.reason;
  try {
    immutable(path.join(pair.root,'summary.json'),summary);
  } catch(error) {
    warning=oneLine(`summary.json not saved: ${error.message}`,config);
  }
  if(warning) {
    console.log(`[summary][WARN] status=${summary.status} reason=${warning}`);
    appendAlert(pair,dependencies,`redmine 요약본 미사용 — ${warning} (자동 게시에서 대체 보고서 선택)`);
  }
  return summary;
}

// The rejected report and validation file a failed generation retained, as absolute paths inside its run.
// Absent or unreadable generation state yields nulls (e.g. the provider failed before any report).
function retainedRejection(child,meetingDate) {
  let validationPath=null,rejectedReportPath=null,rejectedReportHash=null;
  try {
    const state=JSON.parse(fs.readFileSync(buildGenerationStatePath(child.env.outputPath),'utf8'));
    const runDir=path.join(child.env.outputDir,'runs',meetingDate,state.attemptId);
    const owned=name=>{
      const file=typeof name==='string'&&path.basename(name)===name?path.join(runDir,name):null;
      return file&&fs.existsSync(file)?file:null;
    };
    if(state.status==='failed') {
      validationPath=owned(state.latestValidationPath);
      rejectedReportPath=owned(state.latestRejectedReportPath);
      if(rejectedReportPath) rejectedReportHash=state.latestRejectedReportHash||null;
      if(!rejectedReportHash) rejectedReportPath=null;
    }
  } catch {
    // No usable generation state: keep the nulls.
  }
  return {rejectedReportPath,rejectedReportHash,validationPath};
}

// Evidence of a variant that failed validation, as recorded in the pair manifest.
function failedVariant(child,failure) {
  const {rejectedReportPath,rejectedReportHash,validationPath}=retainedRejection(child,failure.meetingDate);
  return {status:'failed',primaryIssueCode:failure.primaryIssueCode,issueCounts:failure.issueCounts,
    rejectedReportPath,rejectedReportHash,validationPath,pipelineAttemptId:failure.pipelineAttemptId};
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
  const manifest={schemaVersion:2,meetingDate:pair.date,defaultPublishDepth:2,snapshotHash:snapshot.contentHash,variants:{}};
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
    } catch(error) {
      // Only a recorded weekly failure is a variant failure; anything else (e.g. IO or ownership errors) still aborts.
      if(!error||!error.weeklyFailure) throw error;
      manifest.variants[depth]=failedVariant(child,error.weeklyFailure.failure);
      console.error(`[pair][WARN] depth${depth} failed: ${manifest.variants[depth].primaryIssueCode}; continuing`);
      continue;
    } finally {
      // The weekly pipeline creates attempt/failure directories even when it throws;
      // keep the whole private bundle private so the next stage reports the real cause.
      privateDirectoryTree(pair.root,{apply:true});
    }
    manifest.variants[depth]={status:'ready',reportHash:generated.state.reportHash,
      generationAttemptId:generated.state.generationAttemptId,pipelineAttemptId:generated.state.pipelineAttemptId};
  }
  immutable(pair.manifestPath,manifest);
  // The mobile briefing prefers depth3 and falls back to a retained selection (#138 R3); without one, send skips it.
  const briefing=resolveBriefing(config,meetingDate);
  if(briefing) immutable(path.join(pair.root,'slack.depth3.json'),briefing);
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

// detailOnly reads one variant (depth3 unless detailDepth says otherwise) for the Slack briefing.
function readWeeklyPair(config,meetingDate,{detailOnly=false,detailDepth=3}={}) {
  const pair=paths(config,meetingDate);
  privateDirectoryTree(pair.root);
  const manifestBytes=read(pair.root,pair.manifestPath);
  const manifest=JSON.parse(manifestBytes);
  if(![1,2].includes(manifest.schemaVersion)||manifest.meetingDate!==pair.date||manifest.defaultPublishDepth!==2
    ||!/^[a-f0-9]{64}$/.test(manifest.snapshotHash)||!manifest.variants
    ||Object.keys(manifest.variants).sort().join(',')!=='2,3') throw new Error('Invalid weekly pair manifest');
  const variants={};
  for(const depth of detailOnly?[detailDepth]:[2,3]) {
    const entry=manifest.variants[depth];
    // Only schemaVersion 2 can record a failed variant; it has no READY evidence to verify.
    if(manifest.schemaVersion===2&&entry&&entry.status==='failed') {
      variants[depth]={failed:true,entry,config:variantConfig(config,pair,depth),state:{status:'failed'}};
      continue;
    }
    if(manifest.schemaVersion===2&&(!entry||entry.status!=='ready')) throw new Error('Invalid weekly pair manifest');
    const allowedStatuses=detailOnly?['ready','publishing','published','failed']:['ready','published'];
    variants[depth]=verifyVariant(pair,manifest.snapshotHash,variantConfig(config,pair,depth),
      manifest.variants[depth],meetingDate,allowedStatuses);
  }
  if(read(pair.root,pair.manifestPath)!==manifestBytes) throw new Error('Pair manifest changed during verification');
  return {...pair,manifest,variants};
}

// Manifest paths of a failed variant are absolute and unbound, so a file is used only when it resolves inside
// the pair root (#138 R4). Returns that in-root path, null for no path or a missing file, or OUTSIDE.
const OUTSIDE=Symbol('outside the pair root');
function pairPath(pair,file) {
  if(file===null||file===undefined) return null;
  if(typeof file!=='string'||!path.isAbsolute(file)) return OUTSIDE;
  let real;
  try {
    real=fs.realpathSync(file);
  } catch {
    return null;
  }
  const relative=path.relative(fs.realpathSync(pair.root),real);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) return OUTSIDE;
  return path.join(pair.root,relative);
}

function briefingFromRun(pair,runDir,reportHash,sourceDepth=3,sourceKind='ready') {
  assertPrivateDirectory(runDir);
  return buildSlackBriefing({meetingDate:pair.date,reportHash,sourceDepth,sourceKind,
    records:JSON.parse(read(pair.root,path.join(runDir,'source-records.json'))),
    selection:JSON.parse(read(pair.root,path.join(runDir,'source-selection.json'))).selection});
}

// The run of a failed variant whose validation rejected a report keeps that run's source selection.
function failedBriefingRun(pair,entry) {
  const reportPath=pairPath(pair,entry.rejectedReportPath);
  if(!reportPath||reportPath===OUTSIDE||pairPath(pair,entry.validationPath)===OUTSIDE) return null;
  if(sha256(read(pair.root,reportPath))!==entry.rejectedReportHash) throw new Error('Rejected report hash mismatch');
  const runDir=path.dirname(reportPath);
  return ['source-records.json','source-selection.json'].every(name=>fs.existsSync(path.join(runDir,name)))
    ?{runDir,reportHash:entry.rejectedReportHash}:null;
}

// The mobile briefing comes from depth3's selection. When depth3 failed it falls back to the selection a failed
// depth3 retained at validation, then to depth2's (#138 R3). Null when no variant kept one.
function resolveBriefing(config,meetingDate) {
  const pair=readWeeklyPair(config,meetingDate,{detailOnly:true});
  const depth3=pair.variants[3];
  if(!depth3.failed) {
    return briefingFromRun(pair,buildRunPaths(depth3.config.env.outputDir,pair.date,depth3.state.generationAttemptId).runDir,
      depth3.state.reportHash,3,'ready');
  }
  const sources=[['failed depth3',3,'retained_rejection',()=>failedBriefingRun(pair,depth3.entry)],['depth2',2,null,()=>{
    const depth2=readWeeklyPair(config,meetingDate,{detailOnly:true,detailDepth:2}).variants[2];
    if(depth2.failed) {
      const retained=failedBriefingRun(pair,depth2.entry);
      return retained&&{...retained,sourceKind:'retained_rejection'};
    }
    return {runDir:buildRunPaths(depth2.config.env.outputDir,pair.date,depth2.state.generationAttemptId).runDir,
      reportHash:depth2.state.reportHash,sourceKind:'ready'};
  }]];
  for(const [label,sourceDepth,sourceKind,source] of sources) {
    try {
      const found=source();
      if(found) return briefingFromRun(pair,found.runDir,found.reportHash,
        sourceDepth,sourceKind||found.sourceKind);
    } catch(error) {
      console.error(`[pair][slack][WARN] ${label} briefing source unusable: ${oneLine(error.message,config)}`);
    }
  }
  return null;
}

function previewWeeklyPair(config,meetingDate) {
  const briefing=resolveBriefing(config,meetingDate);
  if(!briefing) throw new Error('No Slack briefing source: depth3 and depth2 retained no source selection');
  return briefing;
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
    const child=variantConfig(config,pair,3,'summary','freeform');
    const run=buildRunPaths(child.env.outputDir,pair.date,record.generationAttemptId);
    // The prompt input is bound to the generation evidence by verifyVariant below.
    // A missing profile denotes a summary prepared before team reports were enabled.
    const promptInput=JSON.parse(read(pair.root,run.promptInputPath));
    const variant=verifyVariant(pair,record.snapshotHash,summaryConfig(config,pair,promptInput.summaryQualityProfile??null),record,meetingDate,
      ['ready','published'],'freeform');
    // summary.json is a writable record and only the report is bound to the weekly evidence,
    // so the gate is rechecked on the verified report rather than trusted from the record.
    const codes=[...new Set(evaluateSummaryQuality(read(pair.root,variant.state.reportPath),variant.config)
      .blocking.map(issue=>issue.code))];
    if(codes.length) return {reason:'quality_gate: '+codes.join(',')};
    return {variant};
  } catch(error) {
    return {reason:oneLine(error.message,config)};
  }
}

// Producers whose top-level numeric line counts lines of the report itself (parser, report contract). Other
// numeric lines, e.g. source_selection_* lines of the snapshot, never name a report line.
const REPORT_LINE_CODES=new Set(['malformed_fact_marker','undefined_evidence_value']);
const positiveLine=value=>Number.isInteger(value)&&value>0;

function issueReportLine(issue) {
  if(positiveLine(issue?.outputLocation?.line)) return issue.outputLocation.line;
  if(positiveLine(issue?.line)&&REPORT_LINE_CODES.has(issue.code)) return issue.line;
  return undefined;
}

// The lines of a variant's rejected report, re-read and bound to its recorded hash. Null when the report is
// outside the pair root, missing, unreadable or changed, so its numbered issues simply get no excerpt.
function rejectedReportLines(pair,reportPath,reportHash) {
  if(!reportPath||reportPath===OUTSIDE||typeof reportHash!=='string'||!/^[a-f0-9]{64}$/.test(reportHash)) return null;
  try {
    const content=read(pair.root,reportPath);
    return sha256(content)===reportHash?content.split('\n'):null;
  } catch {
    return null;
  }
}

// Only the severity, code and report line text of each validation issue are passed on; issue messages and
// evidence never reach the block. A numbered line becomes the text of that line of the variant's rejected
// report. One issue keeps each numbered line, preferring the first error and then the first warning; every
// issue stays so the per-code counts are unchanged.
// Undefined when the in-root validation file is absent or unreadable.
function validationIssues(pair,validationPath,rejected={}) {
  if(!validationPath||validationPath===OUTSIDE) return undefined;
  let issues;
  try {
    ({issues}=JSON.parse(read(pair.root,validationPath)));
  } catch {
    // An unreadable validation file leaves the recorded counts and reason.
    return undefined;
  }
  if(!Array.isArray(issues)) return undefined;
  let lines;
  const lineOwners=new Map();
  for(const severity of ['error','warning']) {
    issues.forEach((issue,index)=>{
      const number=issueReportLine(issue);
      if(issue?.severity===severity&&number!==undefined&&!lineOwners.has(number)) lineOwners.set(number,index);
    });
  }
  return issues.map((issue,index)=>{
    const entry={severity:issue?.severity,code:issue?.code};
    const number=issueReportLine(issue);
    if(number!==undefined) {
      if(lines===undefined) lines=rejectedReportLines(pair,rejected.reportPath,rejected.reportHash);
      const text=lines&&number<=lines.length?lines[number-1]:undefined;
      if(text===undefined||lineOwners.get(number)!==index) return entry;
      return {...entry,line:text};
    }
    if(typeof issue?.line==='string'&&issue.line.length>0) return {...entry,line:issue.line};
    return entry;
  });
}

// Review input of a failed depth variant and its rejected report when publishable.
function failedDepth(config,pair,name) {
  const {entry}=pair.variants[name];
  const validationPath=pairPath(pair,entry.validationPath);
  const reportPath=pairPath(pair,entry.rejectedReportPath);
  const outside=validationPath===OUTSIDE||reportPath===OUTSIDE;
  const review={status:'failed',primaryIssueCode:entry.primaryIssueCode,issueCounts:{...entry.issueCounts}};
  const issues=validationIssues(pair,validationPath,{reportPath,reportHash:entry.rejectedReportHash});
  if(issues) review.issues=issues;
  if(outside) {
    if(review.issues?.length) review.issues.push({severity:'info',code:'rejected_path_outside_pair'});
    else review.issueCounts.rejected_path_outside_pair=1;
  }
  const rejected=!outside&&reportPath&&/^[a-f0-9]{64}$/.test(entry.rejectedReportHash)
    ?{name,config:variantConfig(config,pair,Number(name)),reportPath,reportHash:entry.rejectedReportHash,
      runDir:path.dirname(reportPath)}:null;
  return {review,rejected,outside};
}

// The summary report rejected after generation: a validated report the quality gate blocked, or the report
// validation rejected and the generation retained. Null when the summary left no report.
function rejectedSummary(config,pair,record) {
  if(!record||record.status!=='failed') return null;
  const child=variantConfig(config,pair,3,'summary','freeform');
  try {
    if(record.reportHash) {
      const state=loadWeeklyStatus(child.env.outputDir,pair.date);
      if(!state||state.reportHash!==record.reportHash||state.reportPath!==child.env.outputPath) return null;
      return {name:'summary',config:child,reportPath:state.reportPath,reportHash:record.reportHash,
        runDir:buildRunPaths(child.env.outputDir,pair.date,state.generationAttemptId).runDir};
    }
    const retained=retainedRejection(child,pair.date);
    const reportPath=pairPath(pair,retained.rejectedReportPath);
    if(!reportPath||reportPath===OUTSIDE) return null;
    return {name:'summary',config:child,reportPath,reportHash:retained.rejectedReportHash,runDir:path.dirname(reportPath)};
  } catch {
    return null;
  }
}

// Quality-gate line numbers name the successful summary report. Re-read only a report whose path and hash
// rejectedSummary and rejectedReportLines bind to this pair; gate messages and evidence are never copied.
function summaryGateIssues(config,pair,record) {
  const blocking=record?.gate?.blocking;
  if(!Array.isArray(blocking)||!record.reportHash) return [];
  const rejected=rejectedSummary(config,pair,record);
  if(!rejected) return [];
  const lines=rejectedReportLines(pair,rejected.reportPath,rejected.reportHash);
  if(!lines) return [];
  return blocking.flatMap(issue=>{
    const number=issue?.line;
    if(typeof issue?.code!=='string'||!positiveLine(number)||number>lines.length) return [];
    return [{severity:'error',code:issue.code,line:lines[number-1]}];
  });
}

// Review input of a failed summary: validation-file issues from a retained rejection plus hash-bound report
// lines named by the quality gate. A part failure retains neither source, so its partFailure issues stay out.
function summaryReview(config,pair,record) {
  if(!record||record.status!=='failed') return record;
  const retained=retainedRejection(variantConfig(config,pair,3,'summary','freeform'),pair.date);
  const validation=validationIssues(pair,pairPath(pair,retained.validationPath),
    {reportPath:pairPath(pair,retained.rejectedReportPath),reportHash:retained.rejectedReportHash})||[];
  const issues=[...validation,...summaryGateIssues(config,pair,record)];
  return issues.length?{...record,issues}:record;
}

// update() refuses a section without exactly one header; skipping such a candidate here lets auto publish
// the next rejected report instead of failing on the first.
function hasSingleSection(pair,candidate) {
  try {
    const content=read(pair.root,candidate.reportPath);
    const header=candidate.config.env.sectionHeader;
    if(content.split(header).length-1!==1) return false;
    return !header.includes('color:blue')||(content.match(/#### <span style="color:blue">/g)||[]).length===1;
  } catch {
    return false;
  }
}

// The footer credits whoever produced the rejected report, as runUpdate does for a ready one.
function rejectedAttribution(pair,runDir) {
  const field=(name,key)=>{
    try {
      return JSON.parse(read(pair.root,path.join(runDir,name)))[key];
    } catch {
      return undefined;
    }
  };
  return {generationProvider:field('prompt-input.json','provider'),generationOrigin:field('source-selection.json','origin')};
}

// The "검토 필요(자동)" block and its alert codes (#138). Dropped evidence comes from the pair's sealed snapshot.
function pairReview(pair,name,rejected,failed,summaryRecord,snapshotPath) {
  const snapshot=verifySnapshot(JSON.parse(read(pair.root,snapshotPath)));
  if(snapshot.contentHash!==pair.manifest.snapshotHash) throw new Error('Pair snapshot evidence mismatch');
  const droppedEvidence=Array.isArray(snapshot.droppedEvidence)?snapshot.droppedEvidence:[];
  const briefingSkipped=!fs.existsSync(path.join(pair.root,'slack.depth3.json'));
  const block=buildReviewBlock({published:{variant:name,status:rejected?'failed':'ready'},
    variants:Object.fromEntries(Object.entries(failed).map(([key,value])=>[key,value.review])),
    summary:summaryRecord,droppedEvidence,briefingSkipped});
  if(!block) return {block,codes:[]};
  const codes=[];
  for(const value of Object.values(failed)) {
    codes.push(value.review.primaryIssueCode||'unknown');
    if(value.outside) codes.push('rejected_path_outside_pair');
  }
  if(summaryRecord&&summaryRecord.status!=='ready') codes.push(`summary_${summaryRecord.status}`);
  if(droppedEvidence.length) codes.push('dropped_evidence');
  if(briefingSkipped) codes.push('briefing_skipped');
  return {block,codes:[...new Set(codes.map(code=>String(code).replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80)))]};
}

async function publishWeeklyPair(config,meetingDate,{depth=2,dependencies={}}={}) {
  if(![2,3,'auto'].includes(depth)) throw new Error('Publish depth must be 2 or 3, or auto');
  const pair=readWeeklyPair(config,meetingDate);
  let name=null,variant=null,generationMethod;
  // A rejected report published as is (#138 D1) when no variant passed.
  let rejected=null;
  // Announced only after the recovery guards below allow the fallback, so an interrupted summary
  // publication is never reported as a fallback.
  let fallbackReason=null;
  if(depth==='auto') {
    // #138 order: ready summary, ready depth2, ready depth3, then the first rejected summary/depth2/depth3 report.
    const summary=selectSummary(config,meetingDate,pair);
    if(summary.variant) ({name,variant,generationMethod}={name:'summary',variant:summary.variant,generationMethod:'freeform'});
    else {
      fallbackReason=summary.reason;
      name=['2','3'].find(key=>!pair.variants[key].failed)||null;
      if(name) variant=pair.variants[name];
    }
  } else {
    name=String(depth);
    variant=pair.variants[name];
    if(variant.failed) throw new Error(`Pair depth${name} failed validation; it cannot be published`);
  }
  const failed=Object.fromEntries(['2','3'].filter(key=>pair.variants[key].failed)
    .map(key=>[key,failedDepth(config,pair,key)]));
  const summaryRecord=readSummaryRecord(pair);
  if(!variant) {
    rejected=[rejectedSummary(config,pair,summaryRecord),failed['2']?.rejected,failed['3']?.rejected]
      .find(candidate=>candidate&&hasSingleSection(pair,candidate))||null;
    if(!rejected) {
      throw Object.assign(new Error('No publishable weekly report: no variant passed and none left a usable rejected report'),
        {code:'NO_PUBLISHABLE_REPORT'});
    }
    name=rejected.name;
    // Never "published": a rerun after the publication is skipped only by the exact rejected receipt below.
    variant={config:rejected.config,state:{status:'rejected',reportDepth:rejected.config.env.reportDepth,
      reportHash:rejected.reportHash}};
  }
  const fallbackTo=`${rejected?'rejected ':''}${name==='summary'?name:'depth'+name}`;
  const publishDependencies={...dependencies,generationMethod};
  const receiptValue={schemaVersion:1,meetingDate:pair.date,depth:variant.state.reportDepth,variant:name,
    reportHash:variant.state.reportHash,...(rejected?{status:'rejected_published'}:{})};
  const started=path.join(pair.root,'publication.started.json');
  const completed=path.join(pair.root,'publication.completed.json');
  if(fs.existsSync(completed)) {
    const receipt=JSON.parse(read(pair.root,completed));
    const intent=JSON.parse(read(pair.root,started));
    if(receipt.schemaVersion!==1||receipt.meetingDate!==pair.date
      ||JSON.stringify(receipt)!==JSON.stringify(intent)) throw new Error('Pair publication receipt evidence mismatch');
    if(rejected) {
      // The same rejected report is already on the Wiki, so a rerun skips it (#138 R10); any other receipt
      // (another variant, report hash, or a ready publication) still needs explicit recovery approval.
      const expectedReceipt={...receiptValue};
      if(Object.prototype.hasOwnProperty.call(receipt,'fallbackAlert')) expectedReceipt.fallbackAlert=receipt.fallbackAlert;
      if(JSON.stringify(receipt)!==JSON.stringify(expectedReceipt)) {
        throw new Error('Already published; replacing a report requires explicit recovery approval');
      }
      recordFallbackAlert(pair,receipt,config,dependencies);
      console.log(`[pair][SKIP] already-published ${fallbackTo}`);
      return {skipped:true,reason:'already-published',state:{status:'rejected_published',
        reportDepth:variant.state.reportDepth,reportPath:rejected.reportPath,reportHash:rejected.reportHash},updateResult:null};
    }
    // Receipts written before the summary variant carry only their depth.
    if((receipt.variant??String(receipt.depth))!==name||receipt.depth!==variant.state.reportDepth
      ||receipt.reportHash!==variant.state.reportHash
      ||variant.state.status!=='published') throw new Error('Already published; replacing a report requires explicit recovery approval');
    if(fallbackReason) console.log(`[summary] fallback to ${fallbackTo}: ${fallbackReason}`);
    const result=await runWeeklyPublish(variant.config,meetingDate,publishDependencies);
    recordFallbackAlert(pair,receipt,config,dependencies);
    return result;
  }
  if(fs.existsSync(started)) throw new Error('Publication needs recovery; inspect the saved attempt before retrying');
  const summaryState=summaryRecord&&summaryRecord.status==='ready'
    ?loadWeeklyStatus(summaryConfig(config,pair).env.outputDir,pair.date):null;
  // A failed variant has no weekly READY state to compare; prepare left it failed and publish never moves it.
  if(Object.values(pair.variants).some(value=>!value.failed&&value.state.status!=='ready')
    ||(summaryRecord&&summaryRecord.status==='ready'&&(!summaryState||summaryState.status!=='ready'))) {
    throw new Error('Pair publication receipt is missing; recovery required before any replacement');
  }
  const legacy=loadWeeklyStatus(config.env.outputDir,pair.date);
  if(legacy&&['failed','publishing','published'].includes(legacy.status)) throw new Error('An existing publication needs inspection before replacing it');
  const review=pairReview(pair,name,rejected,failed,summaryReview(config,pair,summaryRecord),variant.config.env.snapshotPath);
  if(fallbackReason) console.log(`[summary] fallback to ${fallbackTo}: ${fallbackReason}`);
  const publicationReceipt={...receiptValue};
  if(fallbackReason) {
    const message=`redmine 요약본 대체 — ${fallbackTo}: ${oneLine(fallbackReason,config)}`.replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
    publicationReceipt.fallbackAlert={id:fallbackAlertId(receiptValue,message),message};
  }
  immutable(started,publicationReceipt);
  let result;
  try {
    result=rejected
      ?await runWeeklyPublishRejected(rejected.config,meetingDate,{reportPath:rejected.reportPath,
        reportHash:rejected.reportHash,reviewBlock:review.block,snapshotHash:pair.manifest.snapshotHash,
        ...rejectedAttribution(pair,rejected.runDir)})
      :await runWeeklyPublish(variant.config,meetingDate,{...publishDependencies,reviewBlock:review.block});
  } finally {
    // The weekly pipeline creates attempt/failure directories; keep the whole private bundle private.
    privateDirectoryTree(pair.root,{apply:true});
  }
  if(result.state.status!==(rejected?'rejected_published':'published')) throw new Error('Pair publication did not complete; inspect recovery evidence');
  immutable(completed,publicationReceipt);
  recordFallbackAlert(pair,publicationReceipt,config,dependencies);
  if(review.block) {
    appendAlert(pair,dependencies,`redmine 검토 필요 — ${variantLabel(name)} (${review.codes.join(',')})`);
    try {
      // Read by the wrapper's [REVIEW] notice; written only once the section is on the Wiki.
      // variant keeps the machine name; label is the name the notice shows.
      immutable(path.join(pair.root,'review-needed.json'),{schemaVersion:1,meetingDate:pair.date,variant:name,
        label:variantLabel(name),codes:review.codes});
    } catch(error) {
      console.error(`[pair][WARN] review-needed.json not saved: ${oneLine(error.message,config)}`);
    }
  }
  return result;
}

// The prepare log line names each depth variant's outcome, so a failed depth shows in cron.log.
function formatPreparedPairLog({manifest,manifestPath}) {
  const variants=['2','3'].map(key=>{
    const entry=manifest&&manifest.variants?manifest.variants[key]:null;
    const status=entry&&entry.status==='failed'?`failed(${entry.primaryIssueCode||'unknown'})`:(entry&&entry.status)||'missing';
    return `depth${key}=${status}`;
  });
  return `[pair] ${variants.join(' ')} preserved: ${manifestPath}`;
}

async function sendWeeklyPair(config,meetingDate,dependencies={}) {
  const {sendSlackBriefing}=require('./slack-delivery');
  const pair=paths(config,meetingDate);
  const briefing=resolveBriefing(config,meetingDate);
  const savedBriefingPath=path.join(pair.root,'slack.depth3.json');
  if(!briefing) {
    // A saved briefing means prepare found a source; losing it now needs inspection, not a silent skip.
    if(fs.existsSync(savedBriefingPath)) throw new Error('Slack briefing source is missing; inspect the pair');
    console.error('[pair][slack][WARN] no briefing source in depth3 or depth2; skipped');
    appendAlert(pair,dependencies,'redmine 모바일 브리핑 생략 — depth3·depth2 원천 선택 기록 없음');
    return {sent:0,skipped:0,channel:config.env.slackBriefingChannelId,threadTs:null,reportHash:null};
  }
  const expectedBriefing=JSON.stringify(briefing,null,2)+'\n';
  const assertSource=()=>{
    const current=resolveBriefing(config,meetingDate);
    if(!current||current.reportHash!==briefing.reportHash) throw new Error('Slack source report changed');
    if(read(pair.root,savedBriefingPath)!==expectedBriefing) throw new Error('Saved mobile briefing evidence mismatch');
  };
  return sendSlackBriefing({briefing,deliveryDir:path.join(pair.root,'slack-delivery'),
    channel:config.env.slackBriefingChannelId,token:config.env.slackBotToken,
    approvedIdentity:{teamId:config.env.slackBriefingTeamId,botId:config.env.slackBriefingBotId,
      botUserId:config.env.slackBriefingBotUserId,peerUserId:config.env.slackBriefingPeerUserId},
    fetch:dependencies.fetch,sleep:dependencies.sleep,
    assertSource});
}

module.exports={prepareWeeklyPair,readWeeklyPair,previewWeeklyPair,publishWeeklyPair,sendWeeklyPair,formatPreparedPairLog};
