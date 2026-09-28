const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWeeklySelectionStatus } = require('../weekly-selection-status');

function makePair(outputDir, meetingDate, depth, selection) {
  const runDir = path.join(outputDir,'pairs',meetingDate,`depth${depth}`,'runs',meetingDate,'attempt-1');
  fs.mkdirSync(runDir,{recursive:true});
  fs.writeFileSync(path.join(runDir,'source-selection.json'),JSON.stringify(selection));
  const depthDir = path.join(outputDir,'pairs',meetingDate,`depth${depth}`);
  fs.writeFileSync(path.join(depthDir,`report-${meetingDate}.depth${depth}.generation.json`),
    JSON.stringify({meetingDate,reportDepth:depth,runDir}));
  return runDir;
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'weekly-status-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}

test('reports an accepted AI selection', t => {
  const dir = tmpdir(t);
  makePair(dir,'2026-09-30',2,{origin:'ai',errorCode:null});
  assert.deepEqual(readWeeklySelectionStatus(dir,{depth:2}),
    {meetingDate:'2026-09-30',depth:2,origin:'ai',errorCode:null});
});

test('reports a quota-driven fallback distinctly from other fallbacks', t => {
  const dir = tmpdir(t);
  makePair(dir,'2026-09-30',2,{origin:'deterministic_fallback',errorCode:'AI_QUOTA'});
  assert.equal(readWeeklySelectionStatus(dir,{depth:2}).errorCode,'AI_QUOTA');
  const other = tmpdir(t);
  makePair(other,'2026-09-30',2,{origin:'deterministic_fallback',errorCode:'SOURCE_SELECTION_INVALID'});
  assert.equal(readWeeklySelectionStatus(other,{depth:2}).errorCode,'SOURCE_SELECTION_INVALID');
});

test('picks the latest meeting date when several pairs exist', t => {
  const dir = tmpdir(t);
  makePair(dir,'2026-09-16',2,{origin:'ai',errorCode:null});
  makePair(dir,'2026-09-30',2,{origin:'deterministic_fallback',errorCode:'AI_QUOTA'});
  const status = readWeeklySelectionStatus(dir,{depth:2});
  assert.equal(status.meetingDate,'2026-09-30');
  assert.equal(status.errorCode,'AI_QUOTA');
});

test('returns null when there is nothing to judge', t => {
  assert.equal(readWeeklySelectionStatus(tmpdir(t),{depth:2}),null);
});

const { writeActiveOutputDir, readActiveOutputDir, clearActiveOutputDir } = require('../weekly-selection-status');

test('an active output dir pointer round-trips', t => {
  const base = tmpdir(t);
  const target = tmpdir(t);
  makePair(target,'2026-09-30',2,{origin:'ai',errorCode:null});
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:target});
  assert.equal(readActiveOutputDir(base),target);
});

// 만료로 base 로 되돌아가면 send/publish 의 중복 방지 영수증이 우회 디렉터리에
// 남겨진 채 base 의 빈 원장을 보게 되어 Slack 재전송·위키 덮어쓰기가 난다.
// 포인터는 늙지 않고, 대상이 그 회의 pair 를 더는 갖고 있지 않을 때만 무시한다.
test('an old pointer stays valid while its target still holds that meeting pair', t => {
  const base = tmpdir(t);
  const target = tmpdir(t);
  makePair(target,'2026-09-30',2,{origin:'ai',errorCode:null});
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:target});
  const pointer = path.join(base,'weekly-active-output-dir.json');
  const stored = JSON.parse(fs.readFileSync(pointer,'utf8'));
  stored.createdAt = new Date(Date.now()-40*24*60*60*1000).toISOString();
  fs.writeFileSync(pointer,JSON.stringify(stored));
  assert.equal(readActiveOutputDir(base),target);
});

test('a pointer whose target no longer holds that meeting pair is ignored', t => {
  const base = tmpdir(t);
  const target = tmpdir(t);
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:target});
  assert.equal(readActiveOutputDir(base),null);
});

test('a pointer for a different meeting date than its target pair is ignored', t => {
  const base = tmpdir(t);
  const target = tmpdir(t);
  makePair(target,'2026-09-23',2,{origin:'ai',errorCode:null});
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:target});
  assert.equal(readActiveOutputDir(base),null);
});

// prepare 가 시작할 때 지난 포인터를 지우므로 만료가 필요 없다.
test('clearing the pointer leaves the default output dir in use', t => {
  const base = tmpdir(t);
  const target = tmpdir(t);
  makePair(target,'2026-09-30',2,{origin:'ai',errorCode:null});
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:target});
  clearActiveOutputDir(base);
  assert.equal(readActiveOutputDir(base),null);
  clearActiveOutputDir(base); // 없어도 조용히 성공한다
});

test('no pointer means the default output dir stays in use', t => {
  assert.equal(readActiveOutputDir(tmpdir(t)),null);
});
