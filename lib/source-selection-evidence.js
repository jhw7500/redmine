const fs = require('fs');
const path = require('path');
const { hashObject, sha256 } = require('./report-artifact');
const { annotateFactReferences, expandFactReferences } = require('./fact-references');
const { annotateSourceCoverageReferences } = require('./source-coverage');
const { buildSourceRecords, renderSourceSelection, fallbackDetailIssues } = require('./source-selection');

function enforceSourceSelectionStatus(validation, method, {records, evidence, reportDepth} = {}) {
  if (method !== 'source_selection') return validation;
  const issues = validation.issues.map(issue => issue.code.startsWith('open_status_')
    ? {...issue, severity:'error'} : issue);
  if (issues.some(issue => issue.code.startsWith('open_status_'))) issues.push({
    severity:'error', code:'source_selection_status_unverified',
    message:'원문 선택 보고서의 열린 상태 검증은 경고 허용이나 수동 override로 우회할 수 없습니다.',
  });
  for (const check of validation.facts?.openIssueChecks || []) {
    if (check.asOf && !check.repos?.length) issues.push({
      severity:'error', code:'source_selection_status_unverified',
      message:'열린 상태를 확인한 저장소 근거가 없습니다.', line:check.line,
    });
  }
  issues.push(...fallbackDetailIssues(records, evidence, reportDepth));
  return {...validation, issues, status:issues.some(issue=>issue.severity==='error') ? 'FAIL'
    : issues.some(issue=>issue.severity==='warning') ? 'WARNING' : 'PASS'};
}

function assertSourceSelectionEvidence({run, snapshot, generationState, annotatedContent, promptInput, validation, config}) {
  const recordsPath = path.join(run.paths.runDir,'source-records.json');
  const selectionPath = path.join(run.paths.runDir,'source-selection.json');
  const owners = [run.state, generationState, promptInput];
  const enabled = owners.some(owner=>owner?.generationMethod === 'source_selection' || owner?.sourceRecordsHash)
    || fs.existsSync(recordsPath) || fs.existsSync(selectionPath);
  if (!enabled) return;
  const fail = message => { throw Object.assign(new Error(message), {code:'source_selection_evidence_mismatch'}); };
  try {
    if (owners.some(owner=>owner?.generationMethod !== 'source_selection')) fail('Source selection method ownership mismatch');
    const promptText = fs.readFileSync(run.paths.promptInputPath,'utf8');
    const rawAi = fs.readFileSync(run.paths.aiDraftPath,'utf8');
    for (const owner of [run.state,generationState]) {
      if (owner.promptInputHash !== sha256(promptText) || owner.rawAiDraftHash !== sha256(rawAi)) fail('Source selection AI/prompt evidence changed');
    }
    const stored = JSON.parse(fs.readFileSync(recordsPath,'utf8'));
    const selected = JSON.parse(fs.readFileSync(selectionPath,'utf8'));
    const aiSource = annotateSourceCoverageReferences(annotateFactReferences(snapshot.rawContent,run.catalog),run.coverageCatalog);
    const rebuilt = buildSourceRecords(snapshot,aiSource,run.coverageCatalog);
    if (hashObject(stored) !== hashObject(rebuilt)
      || owners.some(owner=>owner.sourceRecordsHash !== rebuilt.recordsHash)) fail('Source records do not match the sealed snapshot');
    const selectionHash = hashObject(selected);
    if ([run.state,generationState].some(owner=>owner.sourceSelectionHash !== selectionHash)
      || (validation && (validation.sourceSelectionHash !== selectionHash || validation.sourceRecordsHash !== rebuilt.recordsHash))) fail('Source selection hash mismatch');
    if (!['ai','deterministic_fallback'].includes(selected.origin)) fail('Unknown selection origin');
    const expected = expandFactReferences(renderSourceSelection(rebuilt, selected.selection, {
      fallback:selected.origin === 'deterministic_fallback',
      leaderHighlight:config?.reportFilter?.leaderHighlight || {},
      reportDepth:config?.env?.reportDepth,
    }), run.catalog);
    if (annotatedContent !== expected) fail('Rendered report no longer matches its source selection; generate a new run');
    return {records:rebuilt, evidence:selected};
  } catch (error) {
    if (error.code === 'source_selection_evidence_mismatch') throw error;
    fail(`Source selection evidence unavailable or invalid: ${error.message}`);
  }
}

module.exports = {enforceSourceSelectionStatus, assertSourceSelectionEvidence};
