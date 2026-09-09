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
  assert.ok(result.validation.issues.some(issue=>issue.code==='open_status_without_as_of'));
  const working = fs.readFileSync(result.runPaths.workingDraftPath,'utf8');
  fs.writeFileSync(result.runPaths.workingDraftPath,working.replace('설치 보류','설치 완료'));
  f.config.env.runId = JSON.parse(fs.readFileSync(result.generationStatePath)).attemptId;
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
