const { test } = require("node:test");
const assert = require("node:assert");

const { sha256 } = require("../report-artifact");
const { buildFactCatalog } = require("../fact-catalog");
const { expandFactReferences, annotateFactReferences } = require("../fact-references");
const {
  annotateSourceCoverageReferences,
  buildSourceCoverageCatalog,
} = require("../source-coverage");
const { validateV2ReportContract } = require("../report-contract");

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
  sourceCoverageMode: "required_sections_and_notion_v1",
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
