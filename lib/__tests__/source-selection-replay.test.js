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

test('offline depth2 replay uses the compact generation format and records its depth', t => {
  const f = fixture(t);
  const args = {snapshotPath:f.snapshotPath,categories:f.config.categories};
  const legacy = replaySnapshot(args);
  const compact = replaySnapshot({...args,reportDepth:2});
  assert.equal(compact.summary.reportDepth,2);
  assert.equal(compact.summary.renderVersion,2);
  assert.equal(compact.summary.selection.status,'PASS');
  assert.doesNotMatch(compact.cleanContent,/원문 발췌/);
  assert.match(compact.cleanContent,/FPS 30 유지/);
  assert.ok(compact.cleanContent.length < legacy.cleanContent.length);
  assert.throws(()=>replaySnapshot({...args,reportDepth:4}),/depth/);
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

test('offline replay blocks detail overflow but preserves the candidate and explicit missing source', t => {
  const f = fixture(t,Array.from({length:10},(_,i)=>`[Notion] 상세 항목 ${i+1}\n      ↳ 수정: 경계 통일`).join('\n    - '));
  const outputDir = path.join(f.dir,'overflow');
  const result = replaySnapshot({snapshotPath:f.snapshotPath,categories:f.config.categories,outputDir});
  assert.equal(result.summary.selection.status,'FAIL');
  assert.equal(result.summary.selection.errors.source_selection_detail_missing,1);
  assert.equal(result.validation.issues.find(issue=>issue.code==='source_selection_detail_missing').id,'R0010');
  assert.match(fs.readFileSync(path.join(outputDir,'report.md'),'utf8'),/↳ 수정: 경계 통일/);
  assert.match(fs.readFileSync(path.join(outputDir,'validation.json'),'utf8'),/source_selection_detail_missing/);
  assert.equal(fs.existsSync(f.reportPath),false);
});

test('fallback total overflow still renders every section and records every omitted detail', t => {
  const categories = {}, autoContent = {}, lines = ['#### 조현우','- PIM'];
  for (let section=0;section<5;section++) {
    const key = `SECTION${section}`;
    categories[key] = {parent:'PIM',label:key,templateKey:key};
    autoContent[`{{${key}}}`] = '- updated';
    lines.push(`  - ${key}`);
    for (let item=0;item<(section===4 ? 1 : 9);item++) {
      lines.push(`    - [Notion] 항목 ${section}-${item}`);
      if (section!==4) lines.push('      ↳ 검증: 재현 시험 통과');
    }
  }
  const f = setupSnapshot(t,{rawContent:lines.join('\n')+'\n',categories,autoContent});
  const result = replaySnapshot({snapshotPath:f.snapshotPath,categories});
  assert.equal(result.summary.selectedRecords,32);
  assert.equal(result.summary.selection.status,'FAIL');
  assert.equal(result.summary.selection.errors.source_selection_detail_missing,5);
  for (const key of Object.keys(categories)) assert.ok(result.cleanContent.includes(key));
  assert.equal(result.summary.selection.errors.missing_source_id,undefined);
});

test('shared category prose survives without requiring every otherwise plain sibling', t => {
  const shared = '검증된 장치에만 적용';
  const f = setupSnapshot(t,{
    rawContent:['#### 조현우','- PIM','  - Application',`    ${shared}`,
      ...Array.from({length:10},(_,i)=>`    - [Notion] 일반 항목 ${i+1}`),''].join('\n'),
    autoContent:{'{{APP}}':'- updated'},categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}},
  });
  const result = replaySnapshot({snapshotPath:f.snapshotPath,categories:f.config.categories});
  assert.equal(result.summary.selectedRecords,9);
  assert.equal(result.summary.selection.status,'WARNING');
  assert.equal(result.summary.selection.errors.source_selection_detail_missing,undefined);
  assert.ok(result.cleanContent.includes(shared));
});
