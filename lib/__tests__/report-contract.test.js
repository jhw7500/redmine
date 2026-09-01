const { test } = require("node:test");
const assert = require("node:assert");

const { sha256 } = require("../report-artifact");
const { buildFactCatalog } = require("../fact-catalog");
const { expandFactReferences, annotateFactReferences } = require("../fact-references");
const {
  annotateSourceCoverageReferences,
  buildSourceCoverageCatalog,
  normalizeSourceCoverageSections,
} = require("../source-coverage");
const { validateV2ReportContract } = require("../report-contract");
const { isPublishable } = require("../report-publishability");

const raw = [
  '#### <span style="color:blue">조현우</span>',
  "- PIM",
  "  - Platform",
  "    - [Notion] test suite 5/8 PASS",
  "- Wireless Lan",
  "  - Network",
  "    - [Notion] packet validation",
  "",
].join("\n");
const coverageCatalog = buildSourceCoverageCatalog({
  autoContent: {
    "{{PLATFORM}}": "- [Notion] test suite 5/8 PASS",
    "{{NETWORK}}": "- [Notion] packet validation",
  },
  rawContent: raw,
}, {
  platform: { label: "Platform", parent: "PIM", templateKey: "PLATFORM" },
  network: { label: "Network", parent: "Wireless Lan", templateKey: "NETWORK" },
});
const factCatalog = buildFactCatalog(raw, [], { knownPaths: coverageCatalog.knownPaths });
const options = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  snapshotHash: "fixture-snapshot-hash",
  sectionHeader: '#### <span style="color:blue">조현우</span>',
  knownPaths: coverageCatalog.knownPaths,
  sourceCoverageMode: "required_sections_notion_advisory_v2",
};
const workingDraft = annotateSourceCoverageReferences(
  expandFactReferences(annotateFactReferences(raw, factCatalog), factCatalog),
  coverageCatalog
);

test("combined contract keeps working-draft hash while stripping source and fact markers", () => {
  const result = validateV2ReportContract(
    raw,
    workingDraft,
    factCatalog,
    coverageCatalog,
    options
  );

  assert.strictEqual(result.validation.annotatedDraftHash, sha256(workingDraft));
  assert.strictEqual(result.validation.coverageCatalogHash, coverageCatalog.coverageCatalogHash);
  assert.strictEqual(result.validation.sourceCoverageMode, options.sourceCoverageMode);
  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(result.cleanContent.includes("[[source:"), false);
  assert.strictEqual(result.cleanContent.includes("[[fact:"), false);
  assert.deepStrictEqual(result.validation.sourceCoverage.required, {
    sections: 2,
    items: 2,
    total: 4,
  });
});

test("combined contract merges coverage and fact failures in one revision", () => {
  const brokenDraft = workingDraft
    .replace("[[fact:T0001|5/8 PASS]]", "[[fact:T0001|5/9 PASS]]")
    .replace(" [[source:N0002]]", "");

  const result = validateV2ReportContract(
    raw,
    brokenDraft,
    factCatalog,
    coverageCatalog,
    options
  );

  assert.ok(result.validation.issues.some((issue) => issue.code === "missing_source_id"));
  assert.ok(result.validation.issues.some((issue) => issue.code === "fact_value_mismatch"));
  assert.strictEqual(result.validation.status, "FAIL");
});

test("missing Notion item coverage is advisory and preserves the coverage metric", () => {
  const draftWithoutOneItem = workingDraft.replace(" [[source:N0002]]", "");

  const result = validateV2ReportContract(
    raw,
    draftWithoutOneItem,
    factCatalog,
    coverageCatalog,
    options
  );

  const missingItem = result.validation.issues.find(
    (issue) => issue.code === "missing_source_id" && issue.id === "N0002"
  );
  assert.strictEqual(missingItem.severity, "warning");
  assert.strictEqual(result.validation.status, "WARNING");
  assert.strictEqual(result.validation.sourceCoverage.complete, false);
  assert.deepStrictEqual(result.validation.sourceCoverage.observed, {
    sections: 2,
    items: 1,
    total: 3,
  });
  assert.strictEqual(isPublishable(result.validation), true);
});

test("section normalization cannot erase protected fact blockers", () => {
  const guardedRaw = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "  - Platform",
    "    - [Notion] fw_reload=1 recovery",
    "",
  ].join("\n");
  const guardedCoverage = buildSourceCoverageCatalog({
    autoContent: { "{{PLATFORM}}": "- [Notion] fw_reload=1 recovery" },
    rawContent: guardedRaw,
  }, {
    platform: { label: "Platform", parent: "PIM", templateKey: "PLATFORM" },
  });
  const guardedFacts = buildFactCatalog(
    guardedRaw,
    [],
    { knownPaths: guardedCoverage.knownPaths }
  );
  const guardedSource = annotateSourceCoverageReferences(
    expandFactReferences(annotateFactReferences(guardedRaw, guardedFacts), guardedFacts),
    guardedCoverage
  );
  const cases = [
    { extra: "fw_reload=1", expectedCode: "unmarked_protected_fact" },
    { extra: "[[fact:Z9999|1]]", expectedCode: "malformed_fact_marker" },
    { extra: "[[Fact:V0001|iMX8MP]]", expectedCode: "malformed_fact_marker" },
    { extra: "[[fact:V9999|1]]", expectedCode: "unknown_fact_id" },
  ];

  for (const { extra, expectedCode } of cases) {
    for (const unsafeHeading of [
      `  - Wrong heading [[source:C0001]] ${extra}`,
      `  - Wrong heading ${extra} [[source:C0001]]`,
    ]) {
      const unsafeDraft = [
        '#### <span style="color:blue">조현우</span>',
        "- PIM",
        unsafeHeading,
        "",
      ].join("\n");
      const normalized = normalizeSourceCoverageSections(
        unsafeDraft,
        guardedSource,
        guardedCoverage,
        guardedFacts
      );
      const result = validateV2ReportContract(
        guardedRaw,
        normalized.content,
        guardedFacts,
        guardedCoverage,
        { ...options, knownPaths: guardedCoverage.knownPaths }
      );

      assert.strictEqual(normalized.content, unsafeDraft, unsafeHeading);
      assert.ok(
        result.validation.issues.some((issue) => issue.code === expectedCode),
        unsafeHeading
      );
      assert.strictEqual(result.validation.status, "FAIL", unsafeHeading);
      assert.strictEqual(isPublishable(result.validation), false, unsafeHeading);
    }
  }
});
