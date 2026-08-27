const { test } = require("node:test");
const assert = require("node:assert");
const fixture = require("./fixtures/report-fact-incidents.json");
const { buildFactCatalog } = require("../fact-catalog");
const { validateAnnotatedReport } = require("../fact-validator");

function baseOptions() {
  return {
    attemptId: "11111111-1111-4111-8111-111111111111",
    meetingDate: "2026-08-26",
    reportDepth: 3,
    snapshotHash: "fixture-snapshot-hash",
    snapshotPath: "/fixture/report.snapshot.json",
    sectionHeader: '#### <span style="color:blue">조현우</span>',
  };
}

test("schema v2 accepts exact facts and rejects both production mutations", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const valid = validateAnnotatedReport(fixture.raw, fixture.valid, catalog, baseOptions());
  assert.strictEqual(valid.validation.status, "PASS");
  assert.strictEqual(valid.cleanContent.includes("[[fact:"), false);

  for (const content of [fixture.changedRatio, fixture.changedPassFail, fixture.changedCounter]) {
    const result = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions());
    assert.strictEqual(result.validation.status, "FAIL");
    const issue = result.validation.issues.find((candidate) => candidate.code === "fact_value_mismatch");
    assert.ok(issue);
    assert.ok(issue.value);
    assert.ok(issue.factId);
    assert.deepStrictEqual(issue.expected, [catalog.facts.find((fact) => fact.id === issue.factId).raw]);
    assert.ok(issue.sourceLocation);
    assert.ok(issue.sourceExcerpt);
    assert.ok(issue.outputLocation);
    assert.ok(issue.outputExcerpt);
  }
});

test("schema v2 reports unmarked and independent section errors together", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const content = `${fixture.valid}\n- invented 77건\n- 다른 줄 [[fact:Q9999|16건]]\n`;
  const { validation } = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions());
  assert.deepStrictEqual(
    validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).sort(),
    ["unknown_fact_id", "unmarked_protected_fact"]
  );
});

test("schema v2 accepts only closed normalization and binds counted subjects", () => {
  const raw = `${fixture.raw}- 센서 16건 점검\n`;
  const catalog = buildFactCatalog(raw);
  const spaced = fixture.valid.replace("5/8 PASS", "5 / 8 PASS");
  assert.strictEqual(validateAnnotatedReport(raw, spaced, catalog, baseOptions()).validation.status, "PASS");

  const wrongSubject = `${fixture.valid}\n- 센서 [[fact:Q0001|16건]] 점검\n`;
  const wrong = validateAnnotatedReport(raw, wrongSubject, catalog, baseOptions()).validation;
  assert.ok(wrong.issues.some((issue) => issue.code === "fact_subject_mismatch"));
});

test("schema v2 rejects arithmetic, conversion, and rounding outside markers", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const content = `${fixture.valid}\n- 파생 집계 13건, 비율 62.5%, 평균 2.7건\n`;
  const validation = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions()).validation;
  assert.ok(validation.issues.filter((issue) => issue.code === "unmarked_protected_fact").length >= 3);
});

test("schema v2 requires an explicit system-fact marker for an ISO date", () => {
  const catalog = buildFactCatalog(fixture.raw, [
    { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
  ]);
  const content = `${fixture.valid}\n- 회의일 2026-08-26\n`;
  const validation = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions()).validation;
  assert.ok(validation.issues.some((issue) => issue.code === "unmarked_protected_fact"));
});

test("schema v2 rejects a changed bare number through the catalog and output scanner", () => {
  const raw = `${baseOptions().sectionHeader}\n- queue depth 4096\n`;
  const catalog = buildFactCatalog(raw);

  assert.deepStrictEqual(catalog.facts.map(({ id, raw: surface }) => [id, surface]), [
    ["Q0001", "4096"],
  ]);
  const validation = validateAnnotatedReport(
    raw,
    `${baseOptions().sectionHeader}\n- queue depth 8192\n`,
    catalog,
    baseOptions()
  ).validation;

  assert.strictEqual(validation.status, "FAIL");
  assert.ok(validation.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "8192"
  ));
});

test("schema v2 binds a bare number to its immediately following Korean counted target", () => {
  const raw = `${baseOptions().sectionHeader}\n- 3 방안 적용\n`;
  const catalog = buildFactCatalog(raw);
  const exact = validateAnnotatedReport(
    raw,
    `${baseOptions().sectionHeader}\n- [[fact:Q0001|3]] 방안 적용\n`,
    catalog,
    baseOptions()
  ).validation;
  const rebound = validateAnnotatedReport(
    raw,
    `${baseOptions().sectionHeader}\n- [[fact:Q0001|3]] 캠페인 적용\n`,
    catalog,
    baseOptions()
  ).validation;

  assert.strictEqual(exact.status, "PASS");
  assert.strictEqual(rebound.status, "FAIL");
  assert.ok(rebound.issues.some((issue) =>
    issue.code === "fact_subject_mismatch"
    && issue.expected.includes("방안")
    && issue.actual === "캠페인"
  ));
});

function assertPartialMarkerRejected(rawLine, annotatedLine, expectedValue) {
  const raw = `${baseOptions().sectionHeader}\n- ${rawLine}\n`;
  const validation = validateAnnotatedReport(
    raw,
    `${baseOptions().sectionHeader}\n- ${annotatedLine}\n`,
    buildFactCatalog(raw),
    baseOptions()
  ).validation;

  assert.strictEqual(validation.status, "FAIL");
  assert.ok(validation.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === expectedValue
  ));
}

test("schema v2 rejects a test result that only intersects a counted marker", () => {
  assertPartialMarkerRejected(
    "16건 저장소 배포",
    "[[fact:Q0001|16건]] PASS, 실패 1건 저장소 배포",
    "16건 PASS, 실패 1건"
  );
});

test("schema v2 rejects a PASS suffix outside a ratio marker", () => {
  assertPartialMarkerRejected("ratio 5/8", "ratio [[fact:V0001|5/8]] PASS", "5/8 PASS");
});

test("schema v2 rejects a percentage suffix outside a decimal marker", () => {
  assertPartialMarkerRejected("success 62.5", "success [[fact:V0001|62.5]]%", "62.5%");
});

test("schema v2 rejects a unit suffix outside a bare-number marker", () => {
  assertPartialMarkerRejected("timeout 4", "timeout [[fact:Q0001|4]] ms", "4 ms");
});
