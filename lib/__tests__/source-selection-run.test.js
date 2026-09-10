const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSnapshot, makeFakeClaude } = require('./helpers/report-run-fixture');
const { runGenerate, runGenerateV2, runRevalidate, assertV2PublishEvidence, assertPublishable, runUpdate } = require('../../index');
const { generateSourceSelection } = require('../source-selection-generation');
const { enforceSourceSelectionStatus } = require('../source-selection-evidence');

const response = JSON.stringify({sections:[{id:'C0001',groups:[{theme:'stability',items:[{id:'R0001',highlight:true}]}]}]});
function setup(t, line = 'FPS 상한 30에서 60으로 변경') {
  const fixture = setupSnapshot(t, {
    rawContent:`#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - 720p 모드에서만\n      - ${line}\n`,
    autoContent:{'{{APP}}':'- updated'}, categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}},
  });
  Object.assign(fixture.config.env, {aiSummarize:true,aiGenerationMethod:'source_selection',sourceSelectionFallback:true});
  fixture.config.reportFilter.leaderHighlight = {enabled:true,maxLines:10};
  fixture.config.env.claudeCli = makeFakeClaude(fixture, response);
  return fixture;
}
function evidenceArgs(fixture, result) {
  return {state:JSON.parse(fs.readFileSync(result.generationStatePath)),reportContent:fs.readFileSync(result.reportPath,'utf8'),snapshot:result.snapshot,meetingDate:fixture.meetingDate,config:fixture.config};
}

test('disabled AI rejects source selection before state writes or provider calls', async t => {
  for (const generate of [runGenerate,runGenerateV2]) {
    const f = setup(t);
    f.config.env.aiSummarize = false;
    const originalFiles = fs.readdirSync(f.dir).sort();
    await assert.rejects(generate(f.config,f.meetingDate),{code:'AI_SELECTION_REQUIRES_AI'});
    assert.deepEqual(fs.readdirSync(f.dir).sort(),originalFiles);
    assert.equal(fs.readFileSync(f.callsPath,'utf8'),'0');
  }
  await assert.rejects(generateSourceSelection({}, {env:{aiSummarize:false}}, new Date(), {}),{code:'AI_SELECTION_REQUIRES_AI'});
});

test('source selection generates a publishable source-bound report with one AI call', async t => {
  const f = setup(t);
  const result = await runGenerateV2(f.config, f.meetingDate);
  assert.notEqual(result.validation.status,'FAIL');
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  const args = evidenceArgs(f,result);
  assert.match(args.reportContent,/720p 모드에서만/);
  assert.match(args.reportContent,/FPS 상한 30에서 60으로 변경/);
  assert.equal(args.state.generationMethod,'source_selection');
  assert.equal(assertV2PublishEvidence(args).validation.publishable,true);
  const {replaySnapshot} = require('../../scripts/replay-source-selection');
  const replay = replaySnapshot({snapshotPath:f.snapshotPath,draftPath:result.runPaths.workingDraftPath,categories:f.config.categories});
  assert.notEqual(replay.summary.previousDraft.status,'FAIL');
});

test('disabled or missing highlight configuration cannot publish an AI highlight', async t => {
  for (const policy of [undefined,{enabled:false,maxLines:0}]) {
    const f = setup(t);
    f.config.reportFilter.leaderHighlight = policy;
    const result = await runGenerateV2(f.config,f.meetingDate);
    const args = evidenceArgs(f,result);
    assert.match(args.reportContent,/원문 기반 대체 보고서/);
    assert.doesNotMatch(args.reportContent,/<u>/);
    assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
    assertV2PublishEvidence(args);
  }
});

test('highlight limits apply during generation and are rechecked before publishing', async t => {
  const f = setup(t);
  const rawContent = '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - 첫 항목\n    - 둘째 항목\n';
  const {sealSnapshot,writeJsonAtomic} = require('../report-artifact');
  writeJsonAtomic(f.snapshotPath,sealSnapshot({...f.snapshot,rawContent}));
  const selected = {sections:[{id:'C0001',groups:[{theme:'stability',items:[
    {id:'R0001',highlight:true},{id:'R0002',highlight:true},
  ]}]}]};
  f.config.env.claudeCli = makeFakeClaude(f,JSON.stringify(selected));
  f.config.reportFilter.leaderHighlight.maxLines = 1;
  const fallback = await runGenerateV2(f.config,f.meetingDate);
  assert.match(fs.readFileSync(fallback.reportPath,'utf8'),/원문 기반 대체 보고서/);
  assert.doesNotMatch(fs.readFileSync(fallback.reportPath,'utf8'),/<u>/);
  f.config.reportFilter.leaderHighlight.maxLines = 2;
  const accepted = await runGenerateV2(f.config,f.meetingDate);
  const args = evidenceArgs(f,accepted);
  assert.equal((args.reportContent.match(/<u>/g)||[]).length,2);
  assertV2PublishEvidence(args);
  f.config.reportFilter.leaderHighlight.maxLines = 1;
  assert.throws(()=>assertV2PublishEvidence(args),{code:'source_selection_evidence_mismatch'});
  f.config.reportFilter.leaderHighlight = {enabled:false,maxLines:0};
  assert.throws(()=>assertV2PublishEvidence(args),{code:'source_selection_evidence_mismatch'});
});

test('invalid selection uses a labelled deterministic fallback without another call', async t => {
  const f = setup(t); f.config.env.claudeCli = makeFakeClaude(f,'{"invented":"text"}');
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.notEqual(result.validation.status,'FAIL');
  assert.match(fs.readFileSync(result.reportPath,'utf8'),/원문 기반 대체 보고서/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  const chosen = JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir,'source-selection.json')));
  assert.equal(chosen.origin,'deterministic_fallback');
  assert.equal(chosen.errorCode,'SOURCE_SELECTION_INVALID');
  assert.equal(fs.readFileSync(result.runPaths.aiDraftPath,'utf8').trim(),'{"invented":"text"}');
});

test('selection fallback is configurable and does not hide unsupported scope or input limits', async t => {
  const f = setup(t); f.config.env.claudeCli = makeFakeClaude(f,'{}');
  f.config.env.sourceSelectionFallback = false;
  await assert.rejects(runGenerateV2(f.config,f.meetingDate),{code:'SOURCE_SELECTION_INVALID'});
  assert.equal(fs.existsSync(f.reportPath),false);
  f.config.env.sourceSelectionFallback = true;
  f.config.env.aiGenerationScope = 'project';
  await assert.rejects(runGenerateV2(f.config,f.meetingDate),{code:'AI_SELECTION_SCOPE'});
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  f.config.env.aiGenerationScope = 'whole'; f.config.env.aiMaxInputChars = 1;
  await assert.rejects(runGenerateV2(f.config,f.meetingDate),{code:'AI_INPUT_LIMIT'});
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
});

test('AI launch failure preserves explicit failure evidence and renders source fallback', async t => {
  const f = setup(t); f.config.env.claudeCli = path.join(f.dir,'missing-cli');
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.notEqual(result.validation.status,'FAIL');
  const chosen = JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir,'source-selection.json')));
  assert.equal(chosen.errorCode,'AI_SPAWN');
  assert.equal(chosen.aiResponseReceived,false);
  assert.equal(fs.readFileSync(result.runPaths.aiDraftPath,'utf8'),'');
  assertV2PublishEvidence(evidenceArgs(f,result));
});

test('source selection preserves untrimmed stdout on success and partial stdout on provider failure', async t => {
  for (const exitCode of [0,1]) {
    const f = setup(t);
    const raw = exitCode ? '  partial JSON from provider\n' : ` \n${response}\n\n`;
    f.config.env.claudeCli = makeFakeClaude(f,raw);
    if (exitCode) fs.appendFileSync(f.config.env.claudeCli,'\nprocess.exitCode = 1;\n');
    const result = await runGenerateV2(f.config,f.meetingDate);
    assert.equal(fs.readFileSync(result.runPaths.aiDraftPath,'utf8'),raw);
    const chosen = JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir,'source-selection.json')));
    assert.equal(chosen.aiResponseReceived,true);
    assert.equal(chosen.errorCode,exitCode ? 'AI_EXIT' : null);
    assertV2PublishEvidence(evidenceArgs(f,result));
  }
});

test('publish evidence rejects altered selection artifacts and metadata downgrade', async t => {
  const f = setup(t); const result = await runGenerateV2(f.config,f.meetingDate);
  const selectionPath = path.join(result.runPaths.runDir,'source-selection.json');
  const original = fs.readFileSync(selectionPath,'utf8');
  fs.writeFileSync(selectionPath,original.replace('true','false'));
  assert.throws(()=>assertV2PublishEvidence(evidenceArgs(f,result)),{code:'source_selection_evidence_mismatch'});
  fs.writeFileSync(selectionPath,original);
  const global = JSON.parse(fs.readFileSync(result.generationStatePath));
  delete global.generationMethod;
  fs.writeFileSync(result.generationStatePath,JSON.stringify(global));
  assert.throws(()=>assertV2PublishEvidence(evidenceArgs(f,result)),{code:'source_selection_evidence_mismatch'});
});

test('raw response artifacts preserve split UTF-8 bytes on successful and failed exits', async t => {
  for (const exitCode of [0,1]) {
    const f = setup(t);
    f.config.env.claudeCli = makeFakeClaude(f,'');
    fs.appendFileSync(f.config.env.claudeCli,[
      'const bytes = Buffer.from("가나다");',
      'process.stdout.write(bytes.subarray(0,1));',
      `setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.exitCode = ${exitCode}; }, 50);`,
    ].join('\n'));
    const result = await runGenerateV2(f.config,f.meetingDate);
    assert.deepEqual(fs.readFileSync(result.runPaths.aiDraftPath),Buffer.from('가나다'));
    const selected = JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir,'source-selection.json')));
    assert.equal(selected.errorCode,exitCode ? 'AI_EXIT' : 'SOURCE_SELECTION_INVALID');
  }
});

test('open status without verification stays blocked and revalidate cannot rewrite it away', async t => {
  const f = setup(t,'설치 보류');
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.equal(result.validation.status,'FAIL');
  assert.equal(fs.existsSync(result.reportPath),false);
  const generationState = JSON.parse(fs.readFileSync(result.generationStatePath));
  const rejectedPath = path.join(result.runPaths.runDir,generationState.latestRejectedReportPath);
  assert.equal(generationState.latestRejectedReportPath,'report.rejected.001.md');
  assert.equal(fs.existsSync(rejectedPath),true);
  assert.doesNotMatch(fs.readFileSync(rejectedPath,'utf8'),/\[\[(?:fact|source):/);
  assert.ok(result.validation.issues.some(issue=>issue.code==='open_status_without_as_of'));
  const working = fs.readFileSync(result.runPaths.workingDraftPath,'utf8');
  fs.writeFileSync(result.runPaths.workingDraftPath,working.replace('설치 보류','설치 완료'));
  f.config.env.runId = generationState.attemptId;
  await assert.rejects(runRevalidate(f.config,f.meetingDate),{code:'source_selection_evidence_mismatch'});
  await assert.rejects(runUpdate(f.config,f.meetingDate),/선행 생성 실패.*FAIL/);
});

test('as-of date alone cannot make unverified open status publishable in source selection', async t => {
  const f = setup(t,'drv.foo (2026-08-20 기준 보류)');
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.equal(result.validation.status,'FAIL');
  assert.ok(result.validation.issues.some(issue=>issue.code==='source_selection_status_unverified'));
});

test('source selection status verification cannot be bypassed with warn or override settings', () => {
  for (const code of ['open_status_resolution_evidence', 'open_status_pickaxe_unavailable']) {
    const validation = enforceSourceSelectionStatus({schemaVersion:2,status:'WARNING',
      issues:[{code,severity:'warning'}],facts:{openIssueChecks:[]}}, 'source_selection');
    for (const env of [{validationMode:'warn'}, {validationMode:'block',validationOverride:true}]) {
      assert.throws(()=>assertPublishable(validation,{env}),{code:'source_selection_status_unverified'});
    }
  }
});

test('fallback detail overflow fails with source IDs and retains rejected reports through revalidation', async t => {
  const f = setup(t);
  const {sealSnapshot,writeJsonAtomic} = require('../report-artifact');
  const rawContent = ['#### <span style="color:blue">조현우</span>','- PIM','  - Application',
    ...Array.from({length:10},(_,i)=>[`    - [Notion] 상세 항목 ${i+1}`,'      ↳ 원인: 경계 조건 불일치'].join('\n')),''].join('\n');
  writeJsonAtomic(f.snapshotPath,sealSnapshot({...f.snapshot,rawContent}));
  f.config.env.claudeCli = makeFakeClaude(f,'{}');
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.equal(result.validation.status,'FAIL');
  assert.equal(result.validation.publishable,false);
  const issue = result.validation.issues.find(issue=>issue.code==='source_selection_detail_missing');
  assert.equal(issue?.id,'R0010');
  assert.equal(issue.sectionId,'C0001');
  assert.match(issue.message,/상세 항목 10/);
  assert.equal(fs.existsSync(result.reportPath),false);
  assert.match(fs.readFileSync(result.rejectedReportPath,'utf8'),/↳ 원인: 경계 조건 불일치/);
  assert.equal(fs.readFileSync(f.callsPath,'utf8'),'1');
  const original = fs.readFileSync(result.rejectedReportPath);
  const state = JSON.parse(fs.readFileSync(result.generationStatePath));
  f.config.env.runId = state.attemptId;
  f.config.env.validationMode = 'warn';
  f.config.env.validationOverride = true;
  const retried = await runRevalidate(f.config,f.meetingDate);
  assert.equal(retried.validation.status,'FAIL');
  assert.equal(retried.validation.publishable,false);
  assert.ok(retried.validation.issues.some(issue=>issue.code==='source_selection_detail_missing'));
  assert.match(retried.rejectedReportPath,/report\.rejected\.002\.md$/);
  assert.deepEqual(fs.readFileSync(result.rejectedReportPath),original);
  assert.deepEqual(fs.readFileSync(retried.rejectedReportPath),original);
  for (const env of [{validationMode:'warn'}, {validationMode:'block',validationOverride:true}]) {
    assert.throws(()=>assertPublishable(retried.validation,{env}),{code:'source_selection_detail_missing'});
  }
  await assert.rejects(runUpdate(f.config,f.meetingDate),/선행 생성 실패.*FAIL/);
});

test('publish rechecks detail coverage even for a hash-consistent historical WARNING fallback', async t => {
  const f = setup(t);
  const {sealSnapshot,writeJsonAtomic,hashObject,sha256} = require('../report-artifact');
  const {renderSourceSelection} = require('../source-selection');
  const {expandFactReferences} = require('../fact-references');
  const rawContent = ['#### <span style="color:blue">조현우</span>','- PIM','  - Application',
    ...Array.from({length:10},(_,i)=>[`    - [Notion] 상세 항목 ${i+1}`,'      ↳ 수정: 경계 통일'].join('\n')),''].join('\n');
  writeJsonAtomic(f.snapshotPath,sealSnapshot({...f.snapshot,rawContent}));
  const selection = {sections:[{id:'C0001',groups:['stability','verification','delivery'].map((theme,g)=>({
    theme,items:Array.from({length:3},(_,i)=>({id:`R${String(g*3+i+1).padStart(4,'0')}`,highlight:false})),
  }))}]};
  f.config.env.claudeCli = makeFakeClaude(f,JSON.stringify(selection));
  const result = await runGenerateV2(f.config,f.meetingDate);
  assert.equal(result.validation.status,'WARNING');
  assertV2PublishEvidence(evidenceArgs(f,result)); // Ordinary AI selection remains advisory.

  // Model a previously accepted fallback, including its exact rendered bytes and
  // all matching hashes. The new coverage gate, not a tamper check, must reject it.
  const read = name=>JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir,name),'utf8'));
  const evidence = {...read('source-selection.json'),origin:'deterministic_fallback',errorCode:'SOURCE_SELECTION_INVALID'};
  const annotated = expandFactReferences(renderSourceSelection(read('source-records.json'),selection,{
    fallback:true,reportDepth:3,leaderHighlight:f.config.reportFilter.leaderHighlight,
  }),read('fact-catalog.json'));
  const {validateV2ReportContract} = require('../report-contract');
  const coverage = read('source-coverage.json');
  const clean = validateV2ReportContract(rawContent,annotated,read('fact-catalog.json'),coverage,{
    sectionHeader:f.config.env.sectionHeader,knownPaths:coverage.knownPaths,repos:{},reportDepth:3,
  }).cleanContent;
  const selectionHash = hashObject(evidence);
  fs.writeFileSync(path.join(result.runPaths.runDir,'source-selection.json'),JSON.stringify(evidence));
  fs.writeFileSync(result.runPaths.workingDraftPath,annotated);
  fs.writeFileSync(result.runPaths.cleanReportPath,clean);
  fs.writeFileSync(result.reportPath,clean);
  const state = JSON.parse(fs.readFileSync(result.generationStatePath));
  const validation = {...result.validation,sourceSelectionHash:selectionHash,
    annotatedDraftHash:sha256(annotated),cleanReportHash:sha256(clean)};
  const validationText = JSON.stringify(validation);
  fs.writeFileSync(path.join(result.runPaths.runDir,state.latestValidationPath),validationText);
  for (const file of [result.generationStatePath,result.runPaths.statePath]) {
    const owner = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file,JSON.stringify({...owner,sourceSelectionHash:selectionHash,
      cleanReportHash:sha256(clean),latestValidationHash:sha256(validationText)}));
  }
  let requests = 0;
  const server = require('node:http').createServer((request,response) => {
    requests++;
    response.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  Object.assign(f.config.env,{baseUrl:`http://127.0.0.1:${server.address().port}`,
    apiKey:'test-key',autoApprove:true,projectId:'p',pageSuffix:'weekly'});
  for (const env of [{validationMode:'warn'}, {validationMode:'block',validationOverride:true}]) {
    Object.assign(f.config.env,env);
    assert.throws(()=>assertV2PublishEvidence(evidenceArgs(f,result)),{code:'source_selection_detail_missing'});
    await assert.rejects(runUpdate(f.config,f.meetingDate),{code:'source_selection_detail_missing'});
  }
  assert.equal(requests,0);
});
