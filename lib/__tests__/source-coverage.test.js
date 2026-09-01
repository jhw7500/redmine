const { test } = require("node:test");
const assert = require("node:assert");

const fixture = require("./fixtures/report-source-coverage-incident.json");
const {
  annotateSourceCoverageReferences,
  buildSourceCoverageCatalog,
  normalizeSourceCoverageSections,
  sourceSectionPathAt,
  validateSourceCoverage,
} = require("../source-coverage");

const snapshot = {
  autoContent: fixture.autoContent,
  rawContent: fixture.rawContent,
};

test("coverage catalog requires populated configured sections and every Notion item", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);

  assert.deepStrictEqual(
    catalog.sections.map(({ id, requiredPath }) => [id, requiredPath]),
    [
      ["C0001", ["PIM", "iMX8MP BSP"]],
      ["C0002", ["Wireless Lan", "iMX93 BSP"]],
    ]
  );
  assert.deepStrictEqual(
    catalog.items.map(({ id, requiredPath }) => [id, requiredPath]),
    [
      ["N0001", ["PIM", "iMX8MP BSP"]],
      ["N0002", ["PIM", "iMX8MP BSP"]],
      ["N0003", ["Wireless Lan", "iMX93 BSP"]],
    ]
  );
});

test("coverage annotation appends bare markers without changing line count", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const annotated = annotateSourceCoverageReferences(fixture.rawContent, catalog);

  assert.match(annotated, /iMX8MP BSP \[\[source:C0001\]\]/);
  assert.match(annotated, /IIM-42652.*\[\[source:N0001\]\]/);
  assert.strictEqual(annotated.split("\n").length, fixture.rawContent.split("\n").length);
});

test("section normalization refuses a marker placed under the wrong parent", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const annotatedSource = annotateSourceCoverageReferences(fixture.rawContent, catalog);
  const wrongParent = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "- Wireless Lan",
    "  - Wrong BSP [[source:C0001]]",
    "",
  ].join("\n");

  const result = normalizeSourceCoverageSections(wrongParent, annotatedSource, catalog);

  assert.strictEqual(result.content, wrongParent);
  assert.deepStrictEqual(result.canonicalizedSectionIds, []);
  assert.deepStrictEqual(result.addedSectionMarkerIds, []);
});

test("section normalization preserves blocking source defects on the heading line", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const annotatedSource = annotateSourceCoverageReferences(fixture.rawContent, catalog);
  const cases = [
    { extra: "[[source:N9999]]", expectedCode: "unknown_source_id" },
    { extra: "[[source:X9999]]", expectedCode: "malformed_source_marker" },
    { extra: "[[source:N0003]]", expectedCode: "source_section_mismatch" },
    { extra: "[[Source:N0002]]", expectedCode: "malformed_source_marker" },
    { extra: "[[ source:N0002]]", expectedCode: "malformed_source_marker" },
    { extra: "[ [source:N0002]]", expectedCode: "malformed_source_marker" },
    { extra: "[[source\u200b:N0002]]", expectedCode: "malformed_source_marker" },
    { extra: "\\[\\[source:N0002]]", expectedCode: "malformed_source_marker" },
  ];

  for (const { extra, expectedCode } of cases) {
    const unsafeHeading = [
      '#### <span style="color:blue">조현우</span>',
      "- PIM",
      `  - Wrong BSP [[source:C0001]] ${extra}`,
      "- Wireless Lan",
      "  - iMX93 BSP [[source:C0002]]",
      "",
    ].join("\n");

    const normalized = normalizeSourceCoverageSections(
      unsafeHeading,
      annotatedSource,
      catalog
    );
    const validation = validateSourceCoverage(normalized.content, catalog);

    assert.strictEqual(normalized.content, unsafeHeading, extra);
    assert.deepStrictEqual(normalized.canonicalizedSectionIds, [], extra);
    assert.ok(validation.issues.some((issue) => issue.code === expectedCode), extra);
  }
});

test("coverage validation rejects missing, duplicate, unknown, and misplaced markers together", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const header = '#### <span style="color:blue">조현우</span>';
  const output = [
    header,
    "- PIM",
    "  - iMX93 BSP [[source:C0001]]",
    "    - IMU [[source:N0001]] [[source:N0001]] [[source:N9999]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "",
  ].join("\n");

  const result = validateSourceCoverage(output, catalog);

  assert.deepStrictEqual(new Set(result.issues.map((issue) => issue.code)), new Set([
    "source_section_heading_mismatch",
    "source_section_mismatch",
    "duplicate_source_id",
    "unknown_source_id",
    "missing_source_id",
  ]));
});

test("ETC markers may be grouped below Personal AI themes", () => {
  const etcSnapshot = {
    autoContent: { "{{ETC_KO}}": "  - [Notion] weekly prompt audit" },
    rawContent: [
      '#### <span style="color:blue">조현우</span>',
      "",
      "- ETC",
      "  - [Notion] weekly prompt audit",
      "",
    ].join("\n"),
  };
  const etcCatalog = buildSourceCoverageCatalog(etcSnapshot, { etc: fixture.categories.etc });
  const validEtcOutput = [
    '#### <span style="color:blue">조현우</span>',
    "- ETC [[source:C0001]]",
    "  - Personal AI",
    "    - Notion [[source:N0001]] [[fact:V0001|weekly]]",
    "",
  ].join("\n");

  const result = validateSourceCoverage(validEtcOutput, etcCatalog);

  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.cleanContent.includes("[[source:"), false);
  assert.match(result.cleanContent, /\[\[fact:V0001\|weekly\]\]/);
});

test("coverage binds canonical roots and multi-level paths to source indentation", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const canonicalOutput = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "  - iMX8MP BSP [[source:C0001]]",
    "    - Bring-up theme",
    "      - IMU and regulatory work [[source:N0001]] [[source:N0002]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - wlan [[source:N0003]]",
    "",
  ].join("\n");
  const nestedPathOutput = canonicalOutput.replace(
    "- PIM\n  - iMX8MP BSP",
    "- ETC\n - PIM\n  - iMX8MP BSP"
  );

  assert.deepStrictEqual(validateSourceCoverage(canonicalOutput, catalog).issues, []);
  assert.ok(validateSourceCoverage(nestedPathOutput, catalog).issues.some(
    (issue) => issue.code === "source_section_heading_mismatch" && issue.id === "C0001"
  ));

  const etcSnapshot = {
    autoContent: { "{{ETC_KO}}": "  - [Notion] weekly prompt audit" },
    rawContent: [
      '#### <span style="color:blue">조현우</span>',
      "",
      "- ETC",
      "  - [Notion] weekly prompt audit",
      "",
    ].join("\n"),
  };
  const etcCatalog = buildSourceCoverageCatalog(etcSnapshot, { etc: fixture.categories.etc });
  const canonicalEtc = [
    '#### <span style="color:blue">조현우</span>',
    "- ETC [[source:C0001]]",
    "  - Personal AI",
    "    - weekly prompt audit [[source:N0001]]",
    "",
  ].join("\n");
  const nestedEtc = canonicalEtc.replace(
    "- ETC [[source:C0001]]",
    "- PIM\n  - ETC [[source:C0001]]"
  );

  assert.deepStrictEqual(validateSourceCoverage(canonicalEtc, etcCatalog).issues, []);
  assert.ok(validateSourceCoverage(nestedEtc, etcCatalog).issues.some(
    (issue) => issue.code === "source_section_heading_mismatch" && issue.id === "C0001"
  ));
});

test("coverage rejects an unmarked duplicate at the canonical structural heading", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const output = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "  - iMX8MP BSP [[source:C0001]]",
    "    - iMX8MP BSP",
    "      - IMU and regulatory work [[source:N0001]] [[source:N0002]]",
    "- PIM",
    "  - iMX8MP BSP",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - wlan [[source:N0003]]",
    "",
  ].join("\n");

  const result = validateSourceCoverage(output, catalog);
  const duplicate = result.issues.find(
    (issue) => issue.code === "duplicate_source_section_heading" && issue.id === "C0001"
  );

  assert.deepStrictEqual(duplicate.requiredPath, ["PIM", "iMX8MP BSP"]);
  assert.strictEqual(duplicate.sourceExcerpt, "iMX8MP BSP");
  assert.strictEqual(duplicate.occurrenceCount, 2);
  assert.deepStrictEqual(
    duplicate.outputLocations.map(({ line }) => line),
    [3, 7]
  );
});

test("coverage validation diagnoses malformed source marker fragments", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const annotated = annotateSourceCoverageReferences(fixture.rawContent, catalog);
  const result = validateSourceCoverage(
    annotated.replace("[[source:N0002]]", "[[source:X0002]]"),
    catalog
  );

  assert.ok(result.issues.some((issue) => issue.code === "malformed_source_marker"));
  assert.ok(result.issues.some((issue) => issue.code === "missing_source_id" && issue.id === "N0002"));
});

test("coverage accepts a configured heading expanded from a valid full fact marker", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  const output = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "  - [[fact:V0001|iMX8MP]] BSP [[source:C0001]]",
    "    - IMU [[source:N0001]] [[source:N0002]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - wlan [[source:N0003]]",
    "",
  ].join("\n");

  const result = validateSourceCoverage(output, catalog);

  assert.deepStrictEqual(result.issues, []);
  assert.match(result.cleanContent, /\[\[fact:V0001\|iMX8MP\]\] BSP/);
  assert.deepStrictEqual(
    sourceSectionPathAt(output, output.indexOf("IMU"), catalog.knownPaths),
    ["PIM", "iMX8MP BSP"]
  );
});
