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

const { writeActiveOutputDir, readActiveOutputDir } = require('../weekly-selection-status');

test('an active output dir pointer round-trips', t => {
  const base = tmpdir(t);
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:'/somewhere/fallback'});
  assert.equal(readActiveOutputDir(base),'/somewhere/fallback');
});

test('a stale pointer is ignored so next week does not inherit it', t => {
  const base = tmpdir(t);
  writeActiveOutputDir(base,{meetingDate:'2026-09-30',outputDir:'/somewhere/fallback'});
  const pointer = path.join(base,'weekly-active-output-dir.json');
  const stored = JSON.parse(fs.readFileSync(pointer,'utf8'));
  stored.createdAt = new Date(Date.now()-25*60*60*1000).toISOString();
  fs.writeFileSync(pointer,JSON.stringify(stored));
  assert.equal(readActiveOutputDir(base),null);
});

test('no pointer means the default output dir stays in use', t => {
  assert.equal(readActiveOutputDir(tmpdir(t)),null);
});
