const { test } = require("node:test");
const assert = require("node:assert");
const fixture = require("./fixtures/report-fact-incidents.json");
const { hasNonOverridableV2Issue } = require("../../index");
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

test("schema v2 rejects facts synthesized from separate source lines", () => {
  const dimensionRaw = `${baseOptions().sectionHeader}\n- queue depth 4096\nx 1080\n`;
  const dimension = validateAnnotatedReport(
    dimensionRaw,
    `${baseOptions().sectionHeader}\n- queue depth: [[fact:Q0001|4096x1080]]\n`,
    buildFactCatalog(dimensionRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(dimension.status, "FAIL");
  assert.ok(dimension.issues.some((issue) => issue.code === "fact_value_mismatch"));

  const countedRaw = `${baseOptions().sectionHeader}\n- 작업 3건\n방안 검토\n`;
  const counted = validateAnnotatedReport(
    countedRaw,
    `${baseOptions().sectionHeader}\n- [[fact:Q0001|3건]] 방안 검토\n`,
    buildFactCatalog(countedRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(counted.status, "FAIL");
  assert.ok(counted.issues.some((issue) =>
    issue.code === "fact_subject_mismatch"
    && issue.expected.includes("작업")
    && issue.actual === "방안"
  ));
});

test("schema v2 closed normalizations preserve same-line tab spacing", () => {
  const raw = `${baseOptions().sectionHeader}\n- ratio 5\t/ 8\n- frame 1920\t× 1080\n`;
  const validation = validateAnnotatedReport(
    raw,
    `${baseOptions().sectionHeader}\n- ratio [[fact:V0001|5/8]]\n- frame [[fact:Q0001|1920x1080]]\n`,
    buildFactCatalog(raw),
    baseOptions()
  ).validation;

  assert.strictEqual(validation.status, "PASS");
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

test("schema v2 binds every deterministic Q subject across label and following-target shapes", () => {
  const cases = [
    {
      rawLine: "3 방안 적용",
      exactLine: "방안 수: [[fact:Q0001|3]].",
      reboundLine: "캠페인 수: [[fact:Q0001|3]].",
      expected: "방안",
      actual: "캠페인",
    },
    {
      rawLine: "queue depth 4096",
      exactLine: "queue depth: [[fact:Q0001|4096]]",
      reboundLine: "[[fact:Q0001|4096]] 캠페인 적용",
      expected: "queue depth",
      actual: "캠페인",
    },
  ];

  for (const fixture of cases) {
    const raw = `${baseOptions().sectionHeader}\n- ${fixture.rawLine}\n`;
    const catalog = buildFactCatalog(raw);
    const validateLine = (line) => validateAnnotatedReport(
      raw,
      `${baseOptions().sectionHeader}\n- ${line}\n`,
      catalog,
      baseOptions()
    ).validation;

    assert.strictEqual(validateLine(fixture.exactLine).status, "PASS");
    const rebound = validateLine(fixture.reboundLine);
    assert.strictEqual(rebound.status, "FAIL");
    assert.ok(rebound.issues.some((issue) =>
      issue.code === "fact_subject_mismatch"
      && issue.expected.includes(fixture.expected)
      && issue.actual === fixture.actual
    ));
  }

  const labelledRaw = `${baseOptions().sectionHeader}\n- queue depth 4096\n`;
  const missing = validateAnnotatedReport(
    labelledRaw,
    `${baseOptions().sectionHeader}\n- [[fact:Q0001|4096]]\n`,
    buildFactCatalog(labelledRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(missing.status, "FAIL");
  assert.ok(missing.issues.some(
    (issue) => issue.code === "fact_subject_mismatch" && issue.actual === null
  ));

  const subjectlessRaw = `${baseOptions().sectionHeader}\n- 4096\n`;
  const subjectless = validateAnnotatedReport(
    subjectlessRaw,
    `${baseOptions().sectionHeader}\n- [[fact:Q0001|4096]]\n`,
    buildFactCatalog(subjectlessRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(subjectless.status, "PASS");
});

test("schema v2 preserves lexical Korean subjects in label and following-target shapes", () => {
  const cases = [
    {
      rawLine: "신뢰도 3",
      exactLine: "신뢰도: [[fact:Q0001|3]]",
      collapsedLine: "신뢰: [[fact:Q0001|3]]",
    },
    {
      rawLine: "3 신뢰도 확인",
      exactLine: "[[fact:Q0001|3]] 신뢰도 확인",
      collapsedLine: "[[fact:Q0001|3]] 신뢰 확인",
    },
  ];

  for (const { rawLine, exactLine, collapsedLine } of cases) {
    const raw = `${baseOptions().sectionHeader}\n- ${rawLine}\n`;
    const catalog = buildFactCatalog(raw);
    const validateLine = (line) => validateAnnotatedReport(
      raw,
      `${baseOptions().sectionHeader}\n- ${line}\n`,
      catalog,
      baseOptions()
    ).validation;

    assert.strictEqual(validateLine(exactLine).status, "PASS");
    const collapsed = validateLine(collapsedLine);
    assert.strictEqual(collapsed.status, "FAIL");
    assert.ok(collapsed.issues.some((issue) =>
      issue.code === "fact_subject_mismatch"
      && issue.expected.includes("신뢰도")
      && issue.actual === "신뢰"
    ));
  }
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

test("schema v2 rejects dropped, flipped, and added numeric signs", () => {
  const signedRaw = `${baseOptions().sectionHeader}\n- 온도 -5 ms\n`;
  const signedCatalog = buildFactCatalog(signedRaw);
  const validateSigned = (surface) => validateAnnotatedReport(
    signedRaw,
    `${baseOptions().sectionHeader}\n- 온도 [[fact:Q0001|${surface}]]\n`,
    signedCatalog,
    baseOptions()
  ).validation;

  for (const surface of ["5 ms", "+5 ms"]) {
    const validation = validateSigned(surface);
    assert.strictEqual(validation.status, "FAIL");
    assert.ok(validation.issues.some((issue) => issue.code === "fact_value_mismatch"));
    assert.strictEqual(hasNonOverridableV2Issue(validation), true);
  }
  assert.strictEqual(validateSigned("-5 ms").status, "PASS");

  const unsignedRaw = `${baseOptions().sectionHeader}\n- 온도 5 ms\n`;
  const addedOutside = validateAnnotatedReport(
    unsignedRaw,
    `${baseOptions().sectionHeader}\n- 온도 -[[fact:Q0001|5 ms]]\n`,
    buildFactCatalog(unsignedRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(addedOutside.status, "FAIL");
  assert.ok(addedOutside.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "-5 ms"
  ));
});

test("schema v2 requires hexadecimal signs inside exact protected markers", () => {
  const signedRaw = `${baseOptions().sectionHeader}\n- 값 -0xFF\n`;
  const signedCatalog = buildFactCatalog(signedRaw);
  const validateSigned = (surface) => validateAnnotatedReport(
    signedRaw,
    `${baseOptions().sectionHeader}\n- 값 [[fact:V0001|${surface}]]\n`,
    signedCatalog,
    baseOptions()
  ).validation;

  assert.strictEqual(validateSigned("-0xFF").status, "PASS");
  for (const surface of ["0xFF", "+0xFF"]) {
    const validation = validateSigned(surface);
    assert.strictEqual(validation.status, "FAIL");
    assert.ok(validation.issues.some((issue) => issue.code === "fact_value_mismatch"));
  }

  const unsignedRaw = `${baseOptions().sectionHeader}\n- 값 0xFF\n`;
  const addedOutside = validateAnnotatedReport(
    unsignedRaw,
    `${baseOptions().sectionHeader}\n- 값 -[[fact:V0001|0xFF]]\n`,
    buildFactCatalog(unsignedRaw),
    baseOptions()
  ).validation;
  assert.strictEqual(addedOutside.status, "FAIL");
  assert.ok(addedOutside.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "-0xFF"
  ));
  assert.strictEqual(hasNonOverridableV2Issue(addedOutside), true);
});
