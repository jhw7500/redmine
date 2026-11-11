const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setupSnapshot,makeFakeClaude}=require('./helpers/report-run-fixture');
const {runGenerateV2,assertV2PublishEvidence}=require('../../index');
const {assertSourceSelectionEvidence}=require('../source-selection-evidence');
const {classifyWeeklyFailure}=require('../weekly-pipeline');

const header='#### <span style="color:blue">조현우</span>';
const profile='team_summary_v1';

test('team claim compiler and selection failures are classified as source selection failures',()=>{
  for(const code of ['TEAM_SUMMARY_SELECTION_INVALID','TEAM_SUMMARY_RECORDS_INVALID']) {
    const failure=classifyWeeklyFailure({stage:'generate',error:Object.assign(new Error('invalid source selection'),{code})});
    assert.equal(failure.code,'source_selection_invalid');
    assert.equal(failure.primaryIssueCode,code);
  }
});

async function prepare(t,aiOutput='invalid selection',rawContent=`${header}\n- PIM\n  - Application\n    - [Notion] 같은 장비의 응답 시간 2~9초 실측\n      ↳ 출처 요약: 같은 장비와 전원 조건에서 응답 시간 2~9초 확인\n`) {
  const f=setupSnapshot(t,{rawContent,
    autoContent:{'{{APP}}':'- updated'},categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}}});
  Object.assign(f.config.env,{aiSummarize:true,aiGenerationMethod:'source_selection',aiGenerationScope:'whole',
    sourceSelectionProfile:profile,sourceSelectionFallback:true,reportAudience:'team',
    claudeCli:makeFakeClaude(f,aiOutput)});
  f.config.reportFilter={teamReport:{enabled:true,selectionProfile:profile},leaderHighlight:{enabled:true,maxLines:10}};
  f.config.depthProfiles={3:{advisoryMaxBullets:60}};
  const result=await runGenerateV2(f.config,f.meetingDate);
  return {...f,result};
}

test('source-fixed team summary uses project coverage and one code-rendered selection',async t=>{
  const f=await prepare(t);
  assert.notEqual(f.result.validation.status,'FAIL',JSON.stringify(f.result.validation.issues));
  const state=JSON.parse(fs.readFileSync(f.generationStatePath,'utf8'));
  assert.equal(state.summaryQualityProfile.schemaVersion,2);
  assert.equal(state.sourceSelectionProfile,profile);
  const records=JSON.parse(fs.readFileSync(path.join(f.result.runPaths.runDir,'source-records.json'),'utf8'));
  assert.equal(records.profile,profile);
  assert.deepEqual(records.sections.map(section=>section.path),[['PIM']]);
  const report=fs.readFileSync(f.reportPath,'utf8');
  assert.match(report,/2~9초/);
  assert.doesNotMatch(report,/Application/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  const proof=assertV2PublishEvidence({state,reportContent:report,snapshot:f.snapshot,meetingDate:f.meetingDate,config:f.config});
  assert.equal(proof.validation.publishable,true);
});

test('a valid AI choice selects the complete measured bundle without a fallback or another call',async t=>{
  const selection={sections:[{id:'C0001',groups:[{theme:'verification',items:[{id:'R0001',highlight:true}]}]}]};
  const f=await prepare(t,JSON.stringify(selection));
  const evidence=JSON.parse(fs.readFileSync(path.join(f.result.runPaths.runDir,'source-selection.json'),'utf8'));
  assert.equal(evidence.origin,'ai');
  assert.equal(evidence.profile,profile);
  const report=fs.readFileSync(f.reportPath,'utf8');
  assert.match(report,/같은 장비와 전원 조건/);
  assert.match(report,/2~9초/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
});

test('a source-fixed working draft cannot change conditions even with matching fact values',async t=>{
  const f=await prepare(t);
  const read=name=>JSON.parse(fs.readFileSync(path.join(f.result.runPaths.runDir,name),'utf8'));
  const run={paths:f.result.runPaths,state:read('state.json'),catalog:read('fact-catalog.json'),coverageCatalog:read('source-coverage.json')};
  const generation=JSON.parse(fs.readFileSync(f.generationStatePath,'utf8'));
  const working=fs.readFileSync(f.result.runPaths.workingDraftPath,'utf8');
  const args={run,snapshot:f.snapshot,generationState:generation,promptInput:read('prompt-input.json'),config:f.config};
  const proof=assertSourceSelectionEvidence({...args,annotatedContent:working});
  assert.ok(proof.factContextProjection);
  const changed=working.replace('같은 장비','다른 장비');
  assert.notEqual(changed,working);
  assert.throws(()=>assertSourceSelectionEvidence({...args,annotatedContent:changed}),/no longer matches/);
  const selectionPath=path.join(f.result.runPaths.runDir,'source-selection.json');
  const selection=read('source-selection.json');
  selection.profile='legacy';
  fs.writeFileSync(selectionPath,JSON.stringify(selection));
  assert.throws(()=>assertSourceSelectionEvidence({...args,annotatedContent:working}),/hash mismatch/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
});

test('source-fixed profile ownership cannot be downgraded to the legacy summary profile',async t=>{
  const f=await prepare(t);
  const state=JSON.parse(fs.readFileSync(f.generationStatePath,'utf8'));
  state.summaryQualityProfile.schemaVersion=1;
  delete state.sourceSelectionProfile;
  fs.writeFileSync(f.generationStatePath,JSON.stringify(state));
  assert.throws(()=>assertV2PublishEvidence({state,reportContent:fs.readFileSync(f.reportPath,'utf8'),
    snapshot:f.snapshot,meetingDate:f.meetingDate,config:f.config}),/profile|ownership/i);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
});

test('generation excludes Git measurements with unowned ancestor conditions before publish proof',async t=>{
  const choice=JSON.stringify({sections:[{id:'C0001',groups:[{theme:'verification',items:[{id:'R0002',highlight:false}]}]}]});
  for(const condition of ['조건: AP 옆에서만','저온 챔버에서 시험','임시 안테나 장착 상태']) {
    const raw=`${header}\n- PIM\n  - Application\n    - [Notion] 독립 응답 확인\n      ↳ 출처 요약: 응답 시간 2~9초 실측\n    - ${condition}\n      - 특정 환경 응답 확인\n        ↳ 목적: 연결 응답 확인\n        ↳ 변경: 응답 시간 11~13초 실측\n`;
    const f=await prepare(t,choice,raw);
    const report=fs.readFileSync(f.reportPath,'utf8');
    assert.doesNotMatch(report,/11~13초/);
    const state=JSON.parse(fs.readFileSync(f.generationStatePath,'utf8'));
    assert.equal(assertV2PublishEvidence({state,reportContent:report,snapshot:f.snapshot,meetingDate:f.meetingDate,config:f.config}).validation.publishable,true);
    assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  }
});

test('a requested detached measurement falls back to its complete qualified bundle at generation and publish',async t=>{
  const choice=JSON.stringify({sections:[{id:'C0001',groups:[{theme:'verification',items:[{id:'R0002',highlight:false}]}]}]});
  const raw=`${header}\n- PIM\n  - Application\n    - 응답 측정 기록\n      ↳ 목적: 연결 응답 확인\n      ↳ 변경: 응답 시간 2~9초 실측\n\n      ↳ 검증: AP 옆에서만 유효\n`;
  const f=await prepare(t,choice,raw);
  const report=fs.readFileSync(f.reportPath,'utf8');
  assert.match(report,/2~9초/);
  assert.match(report,/AP 옆에서만 유효/);
  const state=JSON.parse(fs.readFileSync(f.generationStatePath,'utf8'));
  const args={state,snapshot:f.snapshot,meetingDate:f.meetingDate,config:f.config};
  assert.equal(assertV2PublishEvidence({...args,reportContent:report}).validation.publishable,true);
  assert.throws(()=>assertV2PublishEvidence({...args,reportContent:report.replace('AP 옆에서만 유효','모든 환경에서 유효')}));
  const read=name=>JSON.parse(fs.readFileSync(path.join(f.result.runPaths.runDir,name),'utf8'));
  const run={paths:f.result.runPaths,state:read('state.json'),catalog:read('fact-catalog.json'),coverageCatalog:read('source-coverage.json')};
  const working=fs.readFileSync(f.result.runPaths.workingDraftPath,'utf8');
  assert.throws(()=>assertSourceSelectionEvidence({run,snapshot:f.snapshot,generationState:state,
    annotatedContent:working.replace('AP 옆에서만 유효','모든 환경에서 유효'),promptInput:read('prompt-input.json'),config:f.config}),/no longer matches/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
});
