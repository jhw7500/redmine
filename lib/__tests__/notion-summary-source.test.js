const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mergeItemsIntoAutoContent } = require("../merger");
const { collectSnapshot } = require("../report-snapshot");
const { bindSummaryProvenance } = require("../summary-provenance");
const { hashObject } = require("../report-artifact");
const { buildSourceCoverageCatalog } = require("../source-coverage");
const { buildSourceRecords, buildFallbackSelection, renderSourceSelection, fallbackDetailIssues } = require("../source-selection");
const { runGenerateV2, assertV2PublishEvidence, assertPublishable } = require("../../index");
const { setupSnapshot, makeFakeClaude } = require("./helpers/report-run-fixture");

const categories = {
  app: { parent: "PIM", label: "Application", templateKey: "APP" },
  etc: { parent: "ETC", label: null, templateKey: "ETC" },
};
const range = { start: "2026-09-02", end: "2026-09-09" };
const config = { categories, sources: { notion: { projectMapping: {} } }, repos: {} };
const item = (extra = {}) => ({
  source: "notion", sourceDb: "projects", pageId: "fixture-page", category: "app",
  title: "서비스 복구", date: "2026-09-08",
  summary: "서비스를 복구했고 재발 방지 검사를 추가했다.", ...extra,
});
const cases = [
  { title: "서비스 복구", summary: "서비스를 복구했고 재발 방지 검사를 추가했다." },
  { title: "측정 경로 수정", summary: "수정을 병합했다. 표본이 작아 통계적 효과는 확인하지 못했다." },
  { title: "초기화 실패 분석", summary: "초기화 실패는 장치 수명주기와 재탐색 경합에서 발생하는 것으로 진단했다." },
];

async function collected(t, items, sourceCategories = categories) {
  const f = setupSnapshot(t, { rawContent: "unused", categories: sourceCategories });
  f.meetingDate = new Date("2026-09-09T00:00:00+09:00");
  f.snapshotPath = path.join(f.dir, "new-snapshot.json");
  Object.assign(f.config.env, {
    snapshotPath: f.snapshotPath, templatePath: path.join(f.dir, "template.md"),
    presentationNoteThreshold: 1000, aiSummarize: true, aiGenerationMethod: "source_selection",
    sourceSelectionFallback: true,
  });
  f.config.sources = { notion: { enabled: true }, git: { enabled: false }, session: { enabled: false } };
  fs.writeFileSync(f.config.env.templatePath, [f.config.env.sectionHeader, "- PIM",
    ...Object.values(sourceCategories).filter(c => c.parent === "PIM").flatMap(c => [
      `  - ${c.label}`, `{{${c.templateKey}}}`,
    ]), "",
  ].join("\n"));
  const result = await collectSnapshot(f.config, f.meetingDate, {
    notionApiKey: "fixture-notion-key",
    deps: {
      collectNotionItems: async () => items,
      fetchPageMarkdown: async () => assert.fail("Summary preservation must not add page fetches"),
    },
  });
  f.snapshot = result.snapshot;
  return f;
}

function renderRaw(rawContent, autoContent) {
  const snapshot = { rawContent, autoContent, contentHash: "fixture" };
  const coverage = buildSourceCoverageCatalog(snapshot, categories);
  const records = buildSourceRecords(snapshot, rawContent, coverage);
  return { records, rendered: renderSourceSelection(records, buildFallbackSelection(records)) };
}

for (const example of cases) {
  test(`summary reaches the generated report with its result and caveat: ${example.title}`, async t => {
    const f = await collected(t, [item(example)]);
    f.config.env.claudeCli = makeFakeClaude(f, JSON.stringify({
      sections: [{ id: "C0001", groups: [{
        theme: "verification", items: [{ id: "R0001", highlight: false }],
      }] }],
    }));
    const result = await runGenerateV2(f.config, f.meetingDate);
    const reportContent = fs.readFileSync(result.reportPath, "utf8");
    assert.ok(reportContent.includes(`출처 요약: ${example.summary}`), reportContent);
    assert.ok(result.snapshot.rawContent.includes(example.summary));
    assert.notEqual(result.validation.status, "FAIL", JSON.stringify(result.validation.issues));
    assert.equal(assertV2PublishEvidence({
      state: JSON.parse(fs.readFileSync(result.generationStatePath)),
      reportContent, snapshot: result.snapshot, meetingDate: f.meetingDate, config: f.config,
    }).validation.publishable, true);
    assert.equal(fs.readFileSync(f.callsPath, "utf8"), "1");
  });
}

test("summary preserves multiline conditions without creating separately selectable bullets", () => {
  const summary = "720p 모드에서만 적용한다.\n- 상한을 30에서 60으로 변경했다.\n\n통계적 효과는 확인하지 못했다.";
  const autoContent = mergeItemsIntoAutoContent({}, [item({ summary })], [], config, range);
  const { records, rendered } = renderRaw(
    ["#### 조현우", "- PIM", "  - Application", autoContent["{{APP}}"], ""].join("\n"), autoContent
  );
  assert.equal(records.records.length, 1);
  for (const text of summary.split("\n").filter(Boolean)) assert.ok(rendered.includes(text), rendered);
  assert.match(rendered, /출처 요약:/);
});

test("long summaries preserve every raw line including CRLF boundaries and trailing caveats", () => {
  const longLine = "복구 결과와 조건을 함께 보존한다. ".repeat(700);
  const summary = longLine + "\r\n\r\n  효과 검증은 별도로 남아 있다.  ";
  const autoContent = mergeItemsIntoAutoContent({}, [item({ summary })], [], config, range);
  assert.equal(autoContent["{{APP}}"], [
    "    - [Notion] 서비스 복구",
    "      ↳ 출처 요약: " + longLine,
    "      ↳ 출처 요약: ",
    "      ↳ 출처 요약:   효과 검증은 별도로 남아 있다.  ",
  ].join("\n"));
  const { rendered } = renderRaw(
    ["#### 조현우", "- PIM", "  - Application", autoContent["{{APP}}"], ""].join("\n"), autoContent
  );
  assert.ok(rendered.includes(longLine.trimEnd()));
  assert.ok(rendered.includes("효과 검증은 별도로 남아 있다."));
});

test("summary augments KB briefing without replacing cause, fix, or verification", () => {
  const autoContent = mergeItemsIntoAutoContent({}, [item({
    sourceDb: "knowledgeBase", briefing: {
      cause: "입력 경계가 달랐다.", fix: "경계를 통일했다.", verification: "네 회차 검사를 통과했다.",
    },
  })], [], config, range);
  const content = autoContent["{{APP}}"];
  for (const text of [
    "원인: 입력 경계가 달랐다.", "수정: 경계를 통일했다.", "검증: 네 회차 검사를 통과했다.",
    "출처 요약: 서비스를 복구했고 재발 방지 검사를 추가했다.",
  ]) assert.ok(content.includes(text), content);
});

test("duplicate Git title and repeated Notion input retain the summary exactly once", () => {
  const source = item();
  const autoContent = mergeItemsIntoAutoContent({ "{{APP}}": "    - 서비스 복구" },
    [source, source], [], config, range);
  assert.equal(autoContent["{{APP}}"].split(source.summary).length - 1, 1);
  assert.match(autoContent["{{APP}}"], /\[Notion\] 서비스 복구\n\s+↳ 출처 요약:/);
});

test("shared clauses cannot be removed from a different summary under the same title", () => {
  const first = "서비스를 복구했다.\n재발 방지 검사를 추가했다.";
  const second = "서비스를 복구했다.\n통계적 효과는 확인하지 못했다.";
  const autoContent = mergeItemsIntoAutoContent({}, [item({ summary: first }), item({ summary: second })],
    [], config, range);
  assert.equal(autoContent["{{APP}}"].split("서비스를 복구했다.").length - 1, 2);
  assert.ok(autoContent["{{APP}}"].includes("재발 방지 검사를 추가했다."));
  assert.ok(autoContent["{{APP}}"].includes("통계적 효과는 확인하지 못했다."));
});

test("equal summaries remain attached to each distinct title and category", () => {
  const autoContent = mergeItemsIntoAutoContent({}, [
    item(), item({ title: "별도 서비스 복구" }), item({ category: "etc" }),
  ], [], config, range);
  assert.equal(autoContent["{{APP}}"].split(item().summary).length - 1, 2);
  assert.equal(autoContent["{{ETC}}"].split(item().summary).length - 1, 1);
});

test("previously seen clauses in a new pairing still preserve the complete summary", () => {
  const autoContent = mergeItemsIntoAutoContent({}, [
    item({ summary: "서비스를 복구했다.\n재발 방지 검사를 추가했다." }),
    item({ summary: "수정을 병합했다.\n통계적 효과는 확인하지 못했다." }),
    item({ summary: "서비스를 복구했다.\n통계적 효과는 확인하지 못했다." }),
  ], [], config, range);
  assert.equal(autoContent["{{APP}}"].split("출처 요약:").length - 1, 6);
  assert.match(autoContent["{{APP}}"], /출처 요약: 서비스를 복구했다\.\n\s+↳ 출처 요약: 통계적 효과는 확인하지 못했다\./);
});

test("report exclusion, date range, title rules, category cap, and unmapped categories still block summaries", () => {
  const autoContent = mergeItemsIntoAutoContent({}, [
    item({ title: "최신 항목", date: "2026-09-09", summary: "허용된 복구 결과" }),
    item({ reportExcluded: true, title: "비공개", summary: "private summary" }),
    item({ date: "2026-09-01", summary: "stale summary" }),
    item({ title: "개인 작업", summary: "personal summary" }),
    item({ date: "2026-09-08", summary: "capped summary" }),
    item({ category: "unknown", summary: "unmapped summary" }),
  ], [], {
    ...config, reportFilter: { excludeNotionTitlePatterns: [/개인/], maxItemsPerSubcategory: 1 },
  }, range);
  assert.ok(autoContent["{{APP}}"].includes("허용된 복구 결과"));
  assert.doesNotMatch(JSON.stringify(autoContent), /private summary|stale summary|personal summary|capped summary|unmapped summary/);
});

test("missing, blank, and non-string summaries leave existing output unchanged", () => {
  for (const summary of [undefined, null, "", " \n ", 123, {}]) {
    assert.deepEqual(mergeItemsIntoAutoContent({}, [item({ summary })], [], config, range), {
      "{{APP}}": "    - [Notion] 서비스 복구",
    });
  }
});

test("sealed snapshot is reused byte-for-byte instead of injecting a newly available summary", async t => {
  const f = await collected(t, [item({ summary: "" })]);
  const bytes = fs.readFileSync(f.snapshotPath);
  const reused = await collectSnapshot(f.config, f.meetingDate, {
    notionApiKey: "fixture-notion-key",
    deps: { collectNotionItems: async () => assert.fail("sealed snapshot must not be recollected") },
  });
  assert.equal(reused.reused, true);
  assert.deepEqual(fs.readFileSync(f.snapshotPath), bytes);
  assert.doesNotMatch(reused.snapshot.rawContent, /출처 요약/);
});

test("renderer never promotes selection-only metadata into output source", () => {
  const autoContent = { "{{APP}}": "    - [Notion] 서비스 복구" };
  const { records, rendered } = renderRaw("#### 조현우\n- PIM\n  - Application\n" + autoContent["{{APP}}"], autoContent);
  records.records[0].selectionContext = { summary: "PRIVATE_SELECTION_ONLY" };
  assert.equal(renderSourceSelection(records, buildFallbackSelection(records)), rendered);
  assert.doesNotMatch(rendered, /PRIVATE_SELECTION_ONLY/);
});

test("source creation date cannot make an undated open status publishable", async t => {
  const f = await collected(t, [item({ summary: "복구 후 검증은 미해결 상태다." })]);
  f.config.env.claudeCli = makeFakeClaude(f, JSON.stringify({
    sections: [{ id: "C0001", groups: [{
      theme: "verification", items: [{ id: "R0001", highlight: false }],
    }] }],
  }));
  const result = await runGenerateV2(f.config, f.meetingDate);
  assert.equal(result.validation.status, "FAIL");
  assert.ok(result.validation.issues.some(issue => issue.code === "open_status_without_as_of"));
  assert.throws(() => assertPublishable(result.validation, f.config));
});

test("depth3 fallback preserves selected summaries without requiring every summary-only parent", async t => {
  const letters = "abcdefghij";
  const sourceCategories = Object.fromEntries([..."abcde"].map(key => [key, {
    parent: "PIM", label: `서비스 ${key}`, templateKey: key.toUpperCase(),
  }]));
  const inputs = Object.keys(sourceCategories).flatMap(category => [...letters].map((letter, index) => item({
    category, title: `${category} 결과 ${letter}`, pageId: `${category}-${letter}`,
    summary: "복구를 완료했다.\n통계적 효과는 확인하지 못했다.",
    ...(index === 9 ? { briefing: { verification: "현장 측정을 확인했다." } } : {}),
  })));
  const f = await collected(t, inputs, sourceCategories);
  f.config.env.claudeCli = makeFakeClaude(f, "invalid selection");
  const result = await runGenerateV2(f.config, f.meetingDate);
  assert.notEqual(result.validation.status, "FAIL", JSON.stringify(result.validation.issues));
  const state = JSON.parse(fs.readFileSync(result.generationStatePath));
  const records = buildSourceRecords(result.snapshot, result.snapshot.rawContent,
    buildSourceCoverageCatalog(result.snapshot, sourceCategories));
  const selection = buildFallbackSelection(records, 3);
  const ids = selection.sections.flatMap(s => s.groups.flatMap(g => g.items.map(i => i.id)));
  assert.equal(ids.length, 24);
  assert.ok(selection.sections.every(s => s.groups.flatMap(g => g.items).length <= 9));
  assert.deepEqual(fallbackDetailIssues(records, { origin: "deterministic_fallback", selection }, 3), []);
  assert.equal(fallbackDetailIssues(records, { origin: "deterministic_fallback",
    selection: { sections: [] } }, 3).length, 5);
  const reportContent = fs.readFileSync(result.reportPath, "utf8");
  assert.equal(reportContent.split("출처 요약: 복구를 완료했다.").length - 1, 24);
  assert.equal(reportContent.split("출처 요약: 통계적 효과는 확인하지 못했다.").length - 1, 24);
  assert.equal(reportContent.split("검증: 현장 측정을 확인했다.").length - 1, 5);
  assert.equal(assertV2PublishEvidence({ state, reportContent, snapshot: result.snapshot,
    meetingDate: f.meetingDate, config: f.config }).validation.publishable, true);
  assert.equal(fs.readFileSync(f.callsPath, "utf8"), "1");
});

test("summary label without collection provenance cannot exempt legacy detail from fallback", () => {
  const autoContent = { "{{APP}}": [..."abcdefghij"].map(letter =>
    `    - Git ${letter}\n      ↳ 출처 요약: 원래부터 보호하던 상세 내용`).join("\n") };
  const { records } = renderRaw("#### 조현우\n- PIM\n  - Application\n" + autoContent["{{APP}}"], autoContent);
  const selection = buildFallbackSelection(records, 3);
  assert.equal(fallbackDetailIssues(records, { origin: "deterministic_fallback", selection }, 3).length, 1);
});

test("summary provenance rejects shifted, partial, overlapping, or incorrectly bound source spans", async t => {
  const f = await collected(t, [item({ summary: "복구했다.\n효과는 아직 확인하지 못했다." }),
    item({ title: "다른 서비스", summary: "복구했다.\n효과는 아직 확인하지 못했다." })]);
  assert.ok(f.snapshot.sourceDetails?.spans.length === 2);
  const mutations = [
    s => { s.sourceDetails.schemaVersion = 999; },
    s => { s.sourceDetails.spans[0].sourceIndex = 1; },
    s => { s.sourceDetails.spans[0].sourceIndex = 99; },
    s => { s.sourceDetails.spans[0].startLine++; },
    s => { s.sourceDetails.spans[0].endLine--; },
    s => { s.sourceDetails.spans[0].kind = "optional"; },
    s => { s.sourceDetails.spans.push(s.sourceDetails.spans[0]); },
    s => { Object.assign(s.sourceDetails.spans[0], {
      parentLine: s.sourceDetails.spans[1].parentLine,
      startLine: s.sourceDetails.spans[1].startLine,
      endLine: s.sourceDetails.spans[1].endLine,
    }); s.sourceDetails.spans.pop(); },
    s => { s.rawContent = s.rawContent.replace("출처 요약: 복구했다.", "출처 요약: 바뀐 주장이다."); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(f.snapshot);
    mutate(changed);
    assert.throws(() => buildSourceRecords(changed, changed.rawContent,
      buildSourceCoverageCatalog(changed, categories)), { code: "SOURCE_RECORDS_INVALID" });
  }
});

test("publish evidence rejects a forged summary kind on stored records", async t => {
  const f = await collected(t, [item({ briefing: { verification: "현장 검사를 통과했다." } })]);
  f.config.env.claudeCli = makeFakeClaude(f, "invalid selection");
  const result = await runGenerateV2(f.config, f.meetingDate);
  const recordsPath = path.join(result.runPaths.runDir, "source-records.json");
  const records = JSON.parse(fs.readFileSync(recordsPath));
  records.records[0].continuations[0].kind = "notion_summary";
  fs.writeFileSync(recordsPath, JSON.stringify(records));
  assert.throws(() => assertV2PublishEvidence({
    state: JSON.parse(fs.readFileSync(result.generationStatePath)),
    reportContent: fs.readFileSync(result.reportPath, "utf8"), snapshot: result.snapshot,
    meetingDate: f.meetingDate, config: f.config,
  }), { code: "source_selection_evidence_mismatch" });
});

test("summary provenance cannot name a missing or different template block", async t => {
  const f = await collected(t, [item()]);
  for (const templateKey of ["{{MISSING}}", "{{OTHER}}", null]) {
    const changed = structuredClone(f.snapshot);
    changed.autoContent["{{OTHER}}"] = "    - Git 상세";
    changed.sourceDetails.spans[0].templateKey = templateKey;
    assert.throws(() => buildSourceRecords(changed, changed.rawContent,
      buildSourceCoverageCatalog(changed, categories)), { code: "SOURCE_RECORDS_INVALID" });
  }
});

test("summary provenance follows original inputs through filters, cap sorting, dedup, and title normalization", () => {
  const latest = item({ title: "sample-repo 최신 복구", date: "2026-09-09", summary: "복구했다.\r\n\r\n효과는 확인하지 못했다.  " });
  const sources = [item({ date: "2026-09-01" }), item({ reportExcluded: true }),
    item({ title: "이전 복구", date: "2026-09-08" }), latest, latest];
  const spans = [];
  const autoContent = mergeItemsIntoAutoContent({}, sources, [], {
    ...config, repos: { "sample-repo": { displayName: "표준 이름" } },
    reportFilter: { maxItemsPerSubcategory: 3 },
  }, range, spans);
  const rawContent = ["#### 조현우", "- PIM", "  - Application", autoContent["{{APP}}"], ""].join("\n");
  const snapshot = { rawContent, autoContent, contentHash: "fixture", sources: { notion: { data: sources } },
    sourceDetails: bindSummaryProvenance(autoContent, rawContent, spans, {
      "sample-repo": { displayName: "표준 이름" },
    }) };
  const records = buildSourceRecords(snapshot, rawContent, buildSourceCoverageCatalog(snapshot, categories));
  assert.equal(records.records.length, 2);
  assert.match(records.records[0].text, /표준 이름 최신 복구/);
  assert.deepEqual(spans.map(s => s.sourceIndex), [3, 2]);
  assert.deepEqual(records.records.map(r => r.continuations.filter(c => c.kind === "notion_summary").length), [3, 1]);
  assert.deepEqual(fallbackDetailIssues(records, { origin: "deterministic_fallback",
    selection: { sections: [] } }, 3), []);
});

test("missing, repeated, inline, or subsequently replaced summary blocks fail collection mapping", () => {
  const spans = [];
  const autoContent = mergeItemsIntoAutoContent({}, [item()], [], config, range, spans);
  const block = autoContent["{{APP}}"];
  for (const rawContent of ["#### 조현우\n", block + "\n" + block,
    "prefix " + block, block.replace("서비스를 복구했고", "바뀐 내용")]) {
    assert.throws(() => bindSummaryProvenance(autoContent, rawContent, spans), { code: "SOURCE_RECORDS_INVALID" });
  }
});

test("same-summary source replacement must still match the actual parent derived from that source", async t => {
  const f = await collected(t, [item(), item({ title: "다른 서비스" })]);
  const changed = structuredClone(f.snapshot);
  changed.sourceDetails.spans[0].sourceIndex = 1;
  changed.sourceDetails.spans[0].sourceHash = hashObject(changed.sources.notion.data[1]);
  assert.throws(() => buildSourceRecords(changed, changed.rawContent,
    buildSourceCoverageCatalog(changed, categories)), { code: "SOURCE_RECORDS_INVALID" });
});

test("multiline source titles keep title continuation mandatory while their summary remains whole", async t => {
  const f = await collected(t, [item({ title: "서비스 복구\n      현장 장비에만 적용했다." })]);
  const records = buildSourceRecords(f.snapshot, f.snapshot.rawContent,
    buildSourceCoverageCatalog(f.snapshot, categories));
  const rendered = renderSourceSelection(records, buildFallbackSelection(records, 3), { reportDepth: 3 });
  assert.match(rendered, /현장 장비에만 적용했다\./);
  assert.match(rendered, /출처 요약: 서비스를 복구했고 재발 방지 검사를 추가했다\./);
  assert.equal(records.records[0].continuations.filter(c => c.kind === "notion_summary").length, 1);
  assert.equal(fallbackDetailIssues(records, { origin: "deterministic_fallback",
    selection: { sections: [] } }, 3).length, 1);
});

test("summary provenance cannot exempt an identical preexisting Git detail", () => {
  const source = item();
  const git = { "{{APP}}": `    - [Notion] ${source.title}\n      ↳ 출처 요약: ${source.summary}` };
  const spans = [];
  const autoContent = mergeItemsIntoAutoContent(git, [source], [], config, range, spans);
  const rawContent = ["#### 조현우", "- PIM", "  - Application", autoContent["{{APP}}"], ""].join("\n");
  const snapshot = { rawContent, autoContent, contentHash: "fixture", sources: {
    notion: { data: [source] }, git: { data: git },
  }, sourceDetails: bindSummaryProvenance(autoContent, rawContent, spans) };
  Object.assign(snapshot.sourceDetails.spans[0], { parentLine: 4, startLine: 5, endLine: 5 });
  assert.throws(() => buildSourceRecords(snapshot, rawContent,
    buildSourceCoverageCatalog(snapshot, categories)), { code: "SOURCE_RECORDS_INVALID" });
});

test("CIDR summary survives collection and fallback with its caveat and publish evidence intact", async t => {
  const summary = "경로 192.168.0.0/24를 적용했다.\n통계적 효과는 확인하지 못했다.";
  const f = await collected(t, [item({ summary })]);
  f.config.env.claudeCli = makeFakeClaude(f, "invalid selection");
  const result = await runGenerateV2(f.config, f.meetingDate);
  assert.notEqual(result.validation.status, "FAIL", JSON.stringify(result.validation.issues));
  const reportContent = fs.readFileSync(result.reportPath, "utf8");
  assert.match(reportContent, /원문 기반 대체 보고서/);
  assert.match(reportContent, /출처 요약: 경로 192\.168\.0\.0\/24를 적용했다\./);
  assert.match(reportContent, /출처 요약: 통계적 효과는 확인하지 못했다\./);
  const evidence = { state: JSON.parse(fs.readFileSync(result.generationStatePath)), reportContent,
    snapshot: result.snapshot, meetingDate: f.meetingDate, config: f.config };
  assert.equal(assertV2PublishEvidence(evidence).validation.publishable, true);
  assert.throws(() => assertV2PublishEvidence({ ...evidence,
    reportContent: reportContent.replace("192.168.0.0/24", "192.168.0.0/16"),
  }));
  assert.equal(fs.readFileSync(f.callsPath, "utf8"), "1");
});
