const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveReportReferences, referenceLines } = require('../report-references');
const { collectSnapshot } = require('../report-snapshot');
const { buildSourceRecords, buildFallbackSelection, buildSelectionPrompt, renderSourceSelection } = require('../source-selection');
const { buildSlackBriefing } = require('../slack-briefing');
const { buildSourceCoverageCatalog } = require('../source-coverage');
const { runGenerate, runGenerateV2, assertV2PublishEvidence } = require('../../index');
const { prepareWeeklyPair, readWeeklyPair, previewWeeklyPair } = require('../weekly-report-pair');
const { setupSnapshot, makeFakeClaude } = require('./helpers/report-run-fixture');

const sourceId = 'notion:11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const artifactUrl = 'https://claude.ai/code/artifact/cc15a8af-b891-40d8-8ad0-9248fc3462ec';
const binding = (extra = {}) => ({ sourceId, referencePageId: pageId,
  label: '상세분석', audience: 'team', ...extra });
const source = (extra = {}) => ({ source: 'notion', sourceDb: 'knowledgeBase', sourceId,
  pageId: sourceId.slice(7), title: 'Rate 제어 분석', category: 'app', date: '2026-09-08',
  summary: '적용 경로를 확인했다. 수신 동작은 별도 검증이 필요하다.', ...extra });
const page = (extra = {}) => ({ id: pageId, created_time: '2026-08-10T00:00:00Z',
  last_edited_time: '2026-09-01T00:00:00Z', properties: {
    url: { type: 'url', url: artifactUrl }, report: { type: 'select', select: { name: 'wlan-driver' } },
  }, ...extra });
const cfg = (entries) => ({ sources: { notion: { reportReferences: entries } } });

test('historical reference attaches by exact source ID, never title/project similarity or a new activity', async () => {
  let calls = 0;
  const inputs = [source(), source({ sourceId: 'notion:33333333-3333-4333-8333-333333333333' })];
  const result = await resolveReportReferences(inputs, cfg([binding()]), async id => {
    calls++; assert.equal(id, pageId); return page();
  });
  assert.equal(calls, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-09-08');
  assert.deepEqual(result[0].reportReferences, [{ referencePageId: pageId, label: '상세분석',
    url: artifactUrl, audience: 'team', pageLastEditedTime: '2026-09-01T00:00:00Z' }]);
  assert.equal(result[1].reportReferences, undefined);
  assert.equal(inputs[0].reportReferences, undefined, 'do not mutate collected source items');
});

test('absent weekly source and excluded sources do not fetch old references', async () => {
  const input = [source({ reportExcluded: true })];
  assert.deepEqual(await resolveReportReferences(input, cfg([binding()]), async () => assert.fail('fetch')), input);
  assert.deepEqual(await resolveReportReferences([], cfg([binding()]), async () => assert.fail('fetch')), []);
});

const alphaSourceId = 'notion:abcdefab-cdef-4abc-8def-abcdefabcdef';
const alphaPageId = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
const upperSourceId = 'notion:ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const upperPageId = 'FEDCBAFE-DCBA-4FED-8CBA-FEDCBAFEDCBA';

for (const field of ['configured source', 'collected source', 'configured reference', 'returned page']) {
  test(`UUID case normalization attaches the same reference for ${field}`, async () => {
    const itemId = field === 'collected source' ? upperSourceId : alphaSourceId;
    const input = source({ sourceId: itemId, pageId: itemId.slice(7) });
    const entry = binding({
      sourceId: field === 'configured source' ? upperSourceId : alphaSourceId,
      referencePageId: field === 'configured reference' ? upperPageId : alphaPageId,
      url: 'https://example.com/CaseSensitive/Review#SectionA',
    });
    const original = structuredClone({ input, entry });
    const output = await resolveReportReferences([input], cfg([entry]), async id => {
      assert.equal(id, alphaPageId);
      return page({ id: field === 'returned page' ? upperPageId : alphaPageId });
    });
    assert.deepEqual(output[0].reportReferences, [{ referencePageId: alphaPageId,
      label: '상세분석', url: 'https://example.com/CaseSensitive/Review#SectionA',
      audience: 'team', pageLastEditedTime: '2026-09-01T00:00:00Z' }]);
    assert.equal(output[0].sourceId, itemId, 'retain the original source evidence');
    assert.deepEqual({ input, entry }, original, 'do not mutate collected items or configuration');
  });
}

for (const changed of [{ sourceId: upperSourceId }, { referencePageId: upperPageId }]) {
  test(`UUID case aliases cannot bypass duplicate binding rejection (${Object.keys(changed)[0]})`, async () => {
    const entry = binding({ sourceId: alphaSourceId, referencePageId: alphaPageId });
    let calls = 0;
    await assert.rejects(resolveReportReferences([], cfg([entry, { ...entry, ...changed }]),
      async () => { calls++; return page({ id: alphaPageId }); }), { code: 'REPORT_REFERENCE_INVALID' });
    assert.equal(calls, 0, 'reject invalid configuration even without a matching weekly item');
  });
}

test('UUID case aliases share one cached reference page across distinct weekly sources', async () => {
  const ids = [];
  const output = await resolveReportReferences([source(), source({ sourceId: alphaSourceId })], cfg([
    binding({ referencePageId: alphaPageId }),
    binding({ sourceId: alphaSourceId, referencePageId: upperPageId }),
  ]), async id => { ids.push(id); return page({ id }); });
  assert.deepEqual(ids, [alphaPageId]);
  assert.equal(output.length, 2);
  for (const item of output) {
    assert.equal(item.reportReferences[0].referencePageId, alphaPageId);
    assert.equal(item.reportReferences[0].url, artifactUrl);
  }
});

test('UUID configuration rejects non-string page IDs before fetching', async () => {
  let calls = 0;
  await assert.rejects(resolveReportReferences([source()], cfg([binding({ referencePageId: [pageId] })]),
    async () => { calls++; return page({ id: [pageId] }); }), { code: 'REPORT_REFERENCE_INVALID' });
  assert.equal(calls, 0);
});

test('explicit legacy body URL and version are bound; shared reference page is fetched once', async () => {
  let calls = 0;
  const otherId = 'notion:33333333-3333-4333-8333-333333333333';
  const output = await resolveReportReferences([source(), source({ sourceId: otherId })],
    cfg([binding({ url: 'https://example.com/review', version: '2026-09-11' }), binding({ sourceId: otherId })]),
    async () => { calls++; return page(); });
  assert.equal(calls, 1);
  assert.equal(output[0].reportReferences[0].url, 'https://example.com/review');
  assert.equal(output[0].reportReferences[0].version, '2026-09-11');
  assert.equal(output[1].reportReferences[0].url, artifactUrl);
});

for (const url of ['javascript:alert(1)', 'file:///tmp/report', 'http://example.com/doc',
  'https://user:secret@example.com/doc', 'https://example.com/doc?token=secret',
  'https://example.com/doc?X-Amz-Signature=secret', 'https://example.com/doc#token=secret',
  'https://example.com/\\evil', 'https://example.com/\n- injected']) {
  test(`reject unsafe, expiring or credential-bearing URL (${url.split(':')[0]}) without leaking it`, async () => {
    await assert.rejects(resolveReportReferences([source()], cfg([binding({ url })]), async () => page()),
      error => error.code === 'REPORT_REFERENCE_INVALID' && !error.message.includes('secret') && !error.message.includes(url));
  });
}

test('invalid configuration, duplicate bindings and missing audience fail before fetching', async () => {
  for (const entries of [{}, [binding({ sourceId: 'Rate 제어 분석' })], [binding({ referencePageId: '../secret' })],
    [binding({ audience: 'private' })], [binding({ audience: undefined })],
    [binding({ label: '[click](evil)' })], [binding({ typpo: true })], [binding(), binding()]]) {
    await assert.rejects(resolveReportReferences([source()], cfg(entries), async () => assert.fail('fetch')),
      { code: 'REPORT_REFERENCE_INVALID' });
  }
});

test('missing URL, excluded/private, archived, wrong and inaccessible reference pages block resolution', async () => {
  for (const badPage of [page({ properties: {} }), page({ archived: true }), page({ in_trash: true }),
    page({ id: '33333333-3333-4333-8333-333333333333' }),
    page({ properties: { url: { type: 'url', url: artifactUrl }, report: { type: 'select', select: { name: 'private' } } } })]) {
    await assert.rejects(resolveReportReferences([source()], cfg([binding()]), async () => badPage),
      { code: 'REPORT_REFERENCE_INVALID' });
  }
  await assert.rejects(resolveReportReferences([source()], cfg([binding()]), async () => { throw new Error('secret upstream body'); }),
    error => error.code === 'REPORT_REFERENCE_UNAVAILABLE' && !error.message.includes('secret'));
});

test('three links wrap in pairs with every link/version retained and Markdown-safe URL parentheses', () => {
  const item = { reportReferences: [
    { label: '상세분석', url: 'https://example.com/analysis', audience: 'team' },
    { label: '운영안', url: 'https://example.com/operations', audience: 'team', version: 'v3.5' },
    { label: '추가검증', url: 'https://example.com/a(b)', audience: 'team' },
  ] };
  assert.deepEqual(referenceLines(item, '      '), [
    '      ↳ 자료: [상세분석](https://example.com/analysis) · [운영안 (v3.5)](https://example.com/operations)',
    '      ↳ 자료: [추가검증](https://example.com/a%28b%29)',
  ]);
});

const categories = { app: { parent: 'PIM', label: 'Application', templateKey: 'APP' } };
async function collected(t, reportDepth, items = [source()], entries = [binding()]) {
  const f = setupSnapshot(t, { rawContent: 'unused', reportDepth, categories });
  f.meetingDate = new Date('2026-09-09T00:00:00+09:00');
  f.snapshotPath = path.join(f.dir, 'references.snapshot.json');
  Object.assign(f.config.env, { snapshotPath: f.snapshotPath, templatePath: path.join(f.dir, 'template.md'),
    presentationNoteThreshold: 100000, aiSummarize: true, aiGenerationMethod: 'source_selection', sourceSelectionFallback: true });
  f.config.sources = { notion: { enabled: true, reportReferences: entries }, git: { enabled: false }, session: { enabled: false } };
  fs.writeFileSync(f.config.env.templatePath, [f.config.env.sectionHeader, '- PIM', '  - Application', '{{APP}}', ''].join('\n'));
  f.snapshot = (await collectSnapshot(f.config, f.meetingDate, { notionApiKey: 'fixture-key', deps: {
    collectNotionItems: async () => items, fetchNotionPage: async () => page(),
    fetchPageMarkdown: async () => assert.fail('not an artifact upload or body scrape'),
  } })).snapshot;
  return f;
}

for (const depth of [2, 3]) test(`depth${depth} generated report retains exact artifact URL, caveat and publish evidence`, async t => {
  const f = await collected(t, depth);
  f.config.env.claudeCli = makeFakeClaude(f, 'invalid selection triggers deterministic fallback');
  const result = await runGenerateV2(f.config, f.meetingDate);
  const reportContent = fs.readFileSync(result.reportPath, 'utf8');
  assert.ok(reportContent.includes(`↳ 자료: [상세분석](${artifactUrl})`), reportContent);
  assert.ok(reportContent.includes('수신 동작은 별도 검증이 필요하다.'));
  assert.equal(result.validation.publishable, true, JSON.stringify(result.validation.issues));
  assert.equal(assertV2PublishEvidence({ state: JSON.parse(fs.readFileSync(result.generationStatePath)),
    reportContent, snapshot: result.snapshot, meetingDate: f.meetingDate, config: f.config }).validation.publishable, true);
  assert.equal(fs.readFileSync(f.callsPath, 'utf8'), '1');
  assert.equal(f.snapshot.sources.notion.count, 1);
  assert.ok(f.snapshot.sourceDetails.spans.some(span => span.kind === 'report_reference'));
  const records = JSON.parse(fs.readFileSync(path.join(result.runPaths.runDir, 'source-records.json')));
  assert.equal(records.records[0].continuations.find(line => line.kind === 'report_reference').references[0].url, artifactUrl);
});

test('references without summary survive duplicate titles and stay with their exact source', async t => {
  const otherId = 'notion:33333333-3333-4333-8333-333333333333';
  const f = await collected(t, 3, [source({ summary: undefined }), source({ sourceId: otherId, summary: undefined })],
    [binding(), binding({ sourceId: otherId, url: 'https://example.com/other' })]);
  const records = buildSourceRecords(f.snapshot, f.snapshot.rawContent, buildSourceCoverageCatalog(f.snapshot, categories));
  assert.equal(records.records.length, 2);
  assert.equal(records.records[0].continuations[0].references[0].url, artifactUrl);
  assert.equal(records.records[1].continuations[0].references[0].url, 'https://example.com/other');
});

for (const depth of [2, 3]) for (const details of ['summary', 'briefing', 'both']) {
  test(`depth${depth} linked duplicate retains its own ${details} when the earlier source is omitted`, async t => {
    const otherId = 'notion:33333333-3333-4333-8333-333333333333';
    const summary = details === 'briefing' ? undefined
      : '오프라인 분석에 한정된 결과다.\n실장비 효과로 일반화할 수 없다.';
    const briefing = details === 'summary' ? undefined : {
      cause: '시험용 주파수 설정을 전제로 한다.',
      fix: '시험 경로에만 적용했다.',
      verification: '장시간 운용 효과는 확인하지 않았다.',
    };
    const f = await collected(t, depth, [
      source({ summary, briefing }),
      source({ sourceId: otherId, pageId: otherId.slice(7), summary, briefing }),
      ...Array.from({ length: 8 }, (_, index) => {
        const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        return source({ sourceId: `notion:${id}`, pageId: id, title: `독립 작업 ${index + 1}`, summary: undefined });
      }),
    ], [binding({ sourceId: otherId })]);
    const records = buildSourceRecords(f.snapshot, f.snapshot.rawContent, buildSourceCoverageCatalog(f.snapshot, categories));
    assert.equal(records.records.length, 10);
    const chosen = records.records.slice(1).map(record => ({ id: record.id, highlight: false }));
    const selection = { sections: [{ id: records.sections[0].id, groups:
      ['stability', 'implementation', 'verification'].map((theme, index) => ({
        theme, items: chosen.slice(index * 3, index * 3 + 3),
      })),
    }] };
    const rendered = renderSourceSelection(records, selection, { reportDepth: depth, renderVersion: depth === 2 ? 2 : 1 });
    const conditions = [...(summary ? summary.split('\n') : []), ...Object.values(briefing || {})];
    assert.ok(rendered.includes(artifactUrl));
    for (const condition of conditions) {
      assert.equal(rendered.split(condition).length - 1, 1, `selected source condition missing or duplicated: ${condition}`);
    }
    if (summary) {
      const span = f.snapshot.sourceDetails.spans.find(entry => entry.kind === 'notion_summary' && entry.sourceIndex === 1);
      assert.equal(span?.parentLine, records.records[1].sourceLine, 'summary evidence belongs to the selected second source');
    }
    const mobile = buildSlackBriefing({ meetingDate: '2026-09-09', reportHash: 'a'.repeat(64), records, selection });
    const linkedReply = mobile.replies.find(reply => reply.text.includes(artifactUrl));
    for (const condition of conditions) assert.ok(linkedReply.text.includes(condition), condition);

    f.config.env.sourceSelectionFallback = false;
    f.config.env.claudeCli = makeFakeClaude(f, JSON.stringify(selection));
    const generated = await runGenerateV2(f.config, f.meetingDate);
    const reportContent = fs.readFileSync(generated.reportPath, 'utf8');
    assert.ok(reportContent.includes(artifactUrl));
    for (const condition of conditions) assert.ok(reportContent.includes(condition), condition);
    assert.equal(assertV2PublishEvidence({ state: JSON.parse(fs.readFileSync(generated.generationStatePath)),
      reportContent, snapshot: generated.snapshot, meetingDate: f.meetingDate, config: f.config }).validation.publishable, true);
  });
}

test('duplicate sources without references retain the existing deduplication', async t => {
  const f = await collected(t, 3, [source(), source({ sourceId: 'notion:33333333-3333-4333-8333-333333333333' })], []);
  const records = buildSourceRecords(f.snapshot, f.snapshot.rawContent, buildSourceCoverageCatalog(f.snapshot, categories));
  assert.equal(records.records.length, 1);
  assert.ok(f.snapshot.rawContent.includes('수신 동작은 별도 검증이 필요하다.'));
  assert.ok(!f.snapshot.rawContent.includes('↳ 자료:'));
});

test('source URL corruption and wrong-parent rebinding cannot build selectable records', async t => {
  const f = await collected(t, 3, [source(), source({ title: '다른 업무', sourceId: 'notion:33333333-3333-4333-8333-333333333333' })]);
  const coverage = buildSourceCoverageCatalog(f.snapshot, categories);
  for (const mutate of [
    snapshot => { snapshot.sources.notion.data[0].reportReferences[0].url = 'https://example.com/replaced'; },
    snapshot => { snapshot.sourceDetails.spans.find(span => span.kind === 'report_reference').sourceIndex = 1; },
    snapshot => { snapshot.rawContent = snapshot.rawContent.replace(artifactUrl, 'https://example.com/replaced'); },
  ]) {
    const altered = structuredClone(f.snapshot); mutate(altered);
    assert.throws(() => buildSourceRecords(altered, altered.rawContent, coverage), { code: 'SOURCE_RECORDS_INVALID' });
  }
});

test('artifact URL digits cannot promote a non-measured item or add prompt content', () => {
  const catalog = { heading: '#### 조현우', sections: [{ id: 'C1', path: ['PIM'] }],
    records: Array.from({ length: 10 }, (_, index) => ({ id: `R${index}`, sectionId: 'C1',
      text: index === 9 ? '검증 계획' : '작업 결과', context: [], continuations: [] })) };
  const withReference = structuredClone(catalog);
  withReference.records[9].continuations.push({ kind: 'report_reference', text: `↳ 자료: [상세분석](${artifactUrl})` });
  assert.deepEqual(buildFallbackSelection(withReference, 2, { renderVersion: 2 }),
    buildFallbackSelection(catalog, 2, { renderVersion: 2 }));
  assert.equal(buildSelectionPrompt(withReference, { env: { reportDepth: 2 } }),
    buildSelectionPrompt(catalog, { env: { reportDepth: 2 } }));
});

test('sealed snapshot reuse does not silently change references or fetch pages again', async t => {
  const f = await collected(t, 3);
  f.config.sources.notion.reportReferences[0].url = 'https://example.com/new-version';
  const result = await collectSnapshot(f.config, f.meetingDate, { deps: {
    fetchNotionPage: async () => assert.fail('sealed reuse must not fetch'),
    collectNotionItems: async () => assert.fail('sealed reuse must not collect'),
  } });
  assert.equal(result.reused, true);
  assert.equal(result.snapshot.contentHash, f.snapshot.contentHash);
  assert.equal(result.snapshot.sources.notion.data[0].reportReferences[0].url, artifactUrl);
});

for (const aiSummarize of [true, false]) test(`reference-bearing snapshots reject non-selection generation before output (AI=${aiSummarize})`, async t => {
  const f = await collected(t, 3);
  Object.assign(f.config.env, { aiSummarize, aiGenerationMethod: 'freeform', claudeCli: makeFakeClaude(f, 'unexpected call') });
  await assert.rejects(runGenerate(f.config, f.meetingDate), { code: 'REPORT_REFERENCES_REQUIRE_SELECTION' });
  assert.equal(fs.readFileSync(f.callsPath, 'utf8'), '0');
  assert.equal(fs.existsSync(f.reportPath), false);
});

test('paired outputs and saved mobile links are independently verified; altered link metadata blocks preview', async t => {
  const f = await collected(t, 3);
  const fake = makeFakeClaude(f, JSON.stringify({ sections: [{ id: 'C0001', groups: [{
    theme: 'verification', items: [{ id: 'R0001', highlight: false }],
  }] }] }));
  Object.assign(f.config.env, { aiProvider: 'codex', aiModel: 'gpt-5.6-sol', aiEffort: 'low',
    aiGenerationScope: 'whole', presentationNoteMode: 'suggest', autoApprove: true });
  await prepareWeeklyPair(f.config, f.meetingDate, {
    collect: async () => ({ snapshot: f.snapshot, snapshotPath: f.snapshotPath }),
    generate: (config, date) => runGenerateV2({ ...config, env: { ...config.env,
      aiProvider: 'claude', aiModel: 'sonnet', claudeCli: fake } }, date),
  });
  const pair = readWeeklyPair(f.config, f.meetingDate);
  const originals = [2, 3].map(depth => fs.readFileSync(pair.variants[depth].state.reportPath));
  for (const report of originals) assert.ok(report.toString().includes(`[상세분석](${artifactUrl})`));
  const mobile = previewWeeklyPair(f.config, f.meetingDate);
  assert.equal(mobile.replies[0].blocks.at(-1).elements[0].elements[1].url, artifactUrl);
  for (const [index, depth] of [2, 3].entries()) assert.deepEqual(fs.readFileSync(pair.variants[depth].state.reportPath), originals[index]);
  assert.equal(fs.readFileSync(f.callsPath, 'utf8'), '2');
  const generation = JSON.parse(fs.readFileSync(pair.variants[3].state.reportPath.replace(/\.md$/, '.generation.json')));
  const recordsPath = path.join(generation.runDir, 'source-records.json');
  const records = JSON.parse(fs.readFileSync(recordsPath));
  records.records[0].continuations.find(line => line.kind === 'report_reference').references[0].url = 'https://example.com/wrong';
  fs.writeFileSync(recordsPath, JSON.stringify(records));
  assert.throws(() => previewWeeklyPair(f.config, f.meetingDate), /evidence|source records/i);
});
