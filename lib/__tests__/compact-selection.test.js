const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFallbackSelection, renderSourceSelection } = require('../source-selection');
const { runGenerateV2, assertV2PublishEvidence, runUpdate } = require('../../index');
const { setupSnapshot, makeFakeClaude, setupCompleteV2Run } = require('./helpers/report-run-fixture');

function catalog() {
  const sections = ['Application', 'Driver', 'Test'].map((label, i) => ({
    id: `C${i}`, path: ['PIM', label], headings: ['PIM', label],
  }));
  const records = sections.flatMap(s => Array.from({ length: 12 }, (_, i) => ({
    id: `${s.id}-R${i}`, sectionId: s.id, sourceLine: i + 1,
    text: `routine change ${i}`, annotatedText: `routine change ${i}`, context: [], continuations: [],
  })));
  const measured = records.find(r => r.id === 'C0-R11');
  measured.text = measured.annotatedText = '[Notion] HD60 전달률 실측 — 59.6fps 달성';
  measured.continuations = [{ kind: 'notion_summary', text: '↳ 출처 요약: 현장 조건에서만 확인.',
    annotatedText: '↳ 출처 요약: 현장 조건에서만 확인.' }];
  const fixed = records.find(r => r.id === 'C1-R10');
  fixed.text = fixed.annotatedText = '[Notion] 듀얼와이드 노출 갈림 수정 완료';
  fixed.continuations = [{ kind: 'notion_summary', text: '↳ 출처 요약: 비대칭 조건에서 복구. 다른 조건은 별도 확인.',
    annotatedText: '↳ 출처 요약: 비대칭 조건에서 복구. 다른 조건은 별도 확인.' }];
  return { heading: '#### 조현우', sections, records };
}

test('compact fallback reaches measured results beyond the first nine records without rewriting caveats', () => {
  const c = catalog();
  const selection = buildFallbackSelection(c, 2, { renderVersion: 2 });
  const ids = selection.sections.flatMap(s => s.groups.flatMap(g => g.items.map(i => i.id)));
  assert.equal(ids.length, 16);
  assert.ok(ids.includes('C0-R11'));
  assert.ok(ids.includes('C1-R10'));
  assert.equal(new Set(ids).size, 16);
  assert.ok(selection.sections.every(s => s.groups.flatMap(g => g.items).length <= 9));
  const rendered = renderSourceSelection(c, selection, { fallback: true, reportDepth: 2, renderVersion: 2 });
  assert.match(rendered, /비대칭 조건에서 복구\. 다른 조건은 별도 확인\./);
  assert.equal(rendered.split('원문 기반 대체 보고서').length - 1, 1);
  assert.doesNotMatch(rendered, /원문 발췌/);
  assert.match(rendered, /^    - \[Notion\] HD60/m);
});

test('compact output preserves every selected parent condition and detail even on a legacy detailed snapshot', () => {
  const c = { heading: '#### 조현우', sections: [{ id: 'C1', path: ['PIM'], headings: ['PIM'] }],
    records: [{ id: 'R1', sectionId: 'C1', text: '복구', annotatedText: '복구',
      context: [{ text: '현장 조건', annotatedText: '현장 조건', continuations: [{ text: '주의', annotatedText: '주의' }] }],
      continuations: [{ text: '↳ 검증: 특정 조건 한정', annotatedText: '↳ 검증: 특정 조건 한정' }] }] };
  const selected = buildFallbackSelection(c, 2);
  const compact = renderSourceSelection(c, selected, { fallback: true, reportDepth: 2, renderVersion: 2 });
  assert.match(compact, /현장 조건\n\s+주의\n\s+- 복구\n\s+↳ 검증: 특정 조건 한정/);
  assert.doesNotMatch(compact, /원문 발췌/);
  assert.match(renderSourceSelection(c, selected, { fallback: true, reportDepth: 2 }), /원문 발췌/);
  assert.throws(() => renderSourceSelection(c, selected, { reportDepth: 2, renderVersion: 999 }),
    { code: 'SOURCE_SELECTION_INVALID' });
});

test('compact selection prioritizes measured outcomes and diagnosed failures over measurement guides', () => {
  const c = catalog();
  for (const r of c.records.filter(r => r.sectionId === 'C0' && !r.id.endsWith('R11'))) {
    r.text = r.annotatedText = '[Notion] fps 측정 방법론 3종';
    r.continuations = [{kind:'notion_summary',text:'측정 경로 2종 검증',annotatedText:'측정 경로 2종 검증'}];
  }
  const diagnosed = c.records.find(r => r.id === 'C0-R10');
  diagnosed.text = diagnosed.annotatedText = '[Notion] 360p@120 듀얼와이드 실패 — 근인은 쌍의 노출 갈림 (전면 정정)';
  diagnosed.continuations = [{kind:'notion_summary',text:'두 ISP는 119fps 정상. 갈림만 문제.',
    annotatedText:'두 ISP는 119fps 정상. 갈림만 문제.'}];
  const selection = buildFallbackSelection(c,2,{renderVersion:2});
  const ids = selection.sections.flatMap(s=>s.groups.flatMap(g=>g.items.map(i=>i.id)));
  assert.ok(ids.includes('C0-R11'),'measured HD60 outcome');
  assert.ok(ids.includes('C0-R10'),'diagnosed dualwide failure');
});

test('a commit reference number does not make a measurement-recording title outrank a summarized fix', () => {
  const c = catalog();
  for (const r of c.records.filter(r => r.sectionId === 'C1' && !r.id.endsWith('R10'))) {
    r.text = r.annotatedText = '리뷰-fix round 1: 로그를 정직하게 만들고 실측을 저장소에 남긴다 (#94)';
  }
  const selection = buildFallbackSelection(c,2,{renderVersion:2});
  const ids = selection.sections.flatMap(s=>s.groups.flatMap(g=>g.items.map(i=>i.id)));
  assert.ok(ids.includes('C1-R10'),'summarized repair must survive reference-number noise');
});

test('new depth2 generation binds compact rendering and rejects a changed version before publication', async t => {
  const f = setupSnapshot(t, { reportDepth: 2,
    rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - 복구 완료\n',
    autoContent: { '{{APP}}': '    - 복구 완료' },
    categories: { app: { parent: 'PIM', label: 'Application', templateKey: 'APP' } } });
  Object.assign(f.config.env, { aiSummarize: true, aiGenerationMethod: 'source_selection',
    sourceSelectionFallback: true, claudeCli: makeFakeClaude(f, 'invalid selection') });
  const result = await runGenerateV2(f.config, f.meetingDate);
  const reportContent = fs.readFileSync(result.reportPath, 'utf8');
  const state = JSON.parse(fs.readFileSync(result.generationStatePath));
  const args = { state, snapshot: result.snapshot, reportContent, meetingDate: f.meetingDate, config: f.config };
  assert.equal(assertV2PublishEvidence(args).validation.publishable, true);
  assert.doesNotMatch(reportContent, /원문 발췌/);
  const file = path.join(result.runPaths.runDir, 'source-selection.json');
  const evidence = JSON.parse(fs.readFileSync(file));
  assert.equal(evidence.renderVersion, 2);
  delete evidence.renderVersion;
  fs.writeFileSync(file, JSON.stringify(evidence));
  assert.throws(() => assertV2PublishEvidence(args), { code: 'source_selection_evidence_mismatch' });
});

test('depth2 update still includes selected presentation notes and closes completed notes after Wiki verification', async t => {
  const old = process.env.NOTION_API_KEY;
  process.env.NOTION_API_KEY = 'fixture-only';
  t.after(() => { if (old === undefined) delete process.env.NOTION_API_KEY; else process.env.NOTION_API_KEY = old; });
  const f = await setupCompleteV2Run(t, { reportDepth: 2, presentationNoteMode: 'auto',
    presentationCandidates: [{ pageId: 'page-a', title: '현장 검증 발표', reason: 'tag', tagged: true }] });
  const order = [];
  const originalFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, ...args) => {
    assert.ok(String(url).startsWith(f.config.env.baseUrl + '/'), 'external network forbidden');
    const pathname = new URL(url).pathname;
    if (pathname.includes('/wiki/')) return originalFetch(url, ...args);
    let body;
    if (pathname === '/projects/p.json') body = { project: { id: 7, trackers: [{ id: 8, name: '새기능' }] } };
    else if (pathname === '/issue_statuses.json') body = { issue_statuses: [{ id: 9, name: '검토' }] };
    else if (pathname === '/users/current.json') body = { user: { id: 10 } };
    else if (pathname === '/projects/p/issues.json') {
      order.push('notes');
      body = { issues: [{ id: 123, status: { id: 9 }, description: 'Notion-Page-Id: page-a' }], total_count: 1 };
    } else assert.fail('Unexpected request: ' + pathname);
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  const result = await runUpdate(f.config, f.meetingDate, {
    queryCompletedNotes: async () => { assert.ok(f.redmineRequests.some(r => r.method === 'PUT')); order.push('completed'); return []; },
    closePresentedNotes: async () => [],
  });
  assert.deepEqual(order, ['notes', 'completed']);
  assert.match(fs.readFileSync(result.publishedPath, 'utf8'), /#123/);
});
