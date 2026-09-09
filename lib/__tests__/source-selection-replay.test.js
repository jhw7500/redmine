const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setupSnapshot} = require('./helpers/report-run-fixture');
const {replaySnapshot} = require('../../scripts/replay-source-selection');

function fixture(t, text = 'FPS 30 유지') {
  return setupSnapshot(t,{rawContent:`#### 조현우\n- PIM\n  - Application\n    - ${text}\n`,
    autoContent:{'{{APP}}':'- updated'}, categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}}});
}

test('offline replay uses sealed sources without invoking an AI or creating publish evidence', t => {
  const f = fixture(t);
  const result = replaySnapshot({snapshotPath:f.snapshotPath,categories:f.config.categories});
  assert.equal(result.summary.offlineOnly,true);
  assert.equal(result.summary.aiCalls,0);
  assert.equal(result.summary.selection.status,'PASS');
  assert.equal(result.summary.selectedRecords,1);
  assert.match(result.cleanContent,/FPS 30 유지/);
  assert.equal(fs.existsSync(f.reportPath),false);
});

test('offline replay exposes unverified open state and refuses existing output directories', t => {
  const f = fixture(t, 'drv.foo (2026-08-20 기준 보류)');
  const outputDir = path.join(f.dir,'replay');
  const args = {snapshotPath:f.snapshotPath,categories:f.config.categories,outputDir};
  const result = replaySnapshot(args);
  assert.equal(result.summary.selection.status,'FAIL');
  assert.ok(result.summary.selection.errors.source_selection_status_unverified);
  assert.match(fs.readFileSync(path.join(outputDir,'report.md'),'utf8'),/보류/);
  assert.throws(()=>replaySnapshot(args),/EEXIST/);
});

test('offline replay refuses a tampered snapshot before producing output', t => {
  const f = fixture(t);
  const snapshot = JSON.parse(fs.readFileSync(f.snapshotPath));
  snapshot.rawContent += 'tampered';
  fs.writeFileSync(f.snapshotPath,JSON.stringify(snapshot));
  assert.throws(()=>replaySnapshot({snapshotPath:f.snapshotPath,categories:f.config.categories}),/hash mismatch/);
});
