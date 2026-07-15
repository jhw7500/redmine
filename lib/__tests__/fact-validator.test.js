const { test } = require("node:test");
const assert = require("node:assert");
const { extractTestFacts, validateReport } = require("../fact-validator");

const HEADER = '#### <span style="color:blue">조현우</span>';

function validate(rawLine, outputLine) {
  return validateReport(
    `${HEADER}\n- ${rawLine}\n`,
    `${HEADER}\n- ${outputLine}\n`,
    { sectionHeader: HEADER, meetingDate: "2026-07-15", reportDepth: 3 }
  );
}

test("PASS count/fail count source supports explicit and passed/total output", () => {
  assert.deepStrictEqual(
    extractTestFacts("실타깃 PASS 34/0")[0],
    { pass: 34, fail: 0, total: 34, raw: "PASS 34/0" }
  );
  assert.strictEqual(validate("실타깃 PASS 34/0", "실타깃 34건 PASS, 실패 0건").status, "PASS");
  assert.strictEqual(validate("실타깃 PASS 34/0", "실타깃 34/34 PASS").status, "PASS");
});

test("34/0 PASS is rejected because total is smaller than passed", () => {
  const result = validate("실타깃 PASS 34/0", "실타깃 34/0 PASS");

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.code === "invalid_test_ratio"));
});

test("invented protected numbers and versions are rejected", () => {
  const result = validate("v1.2.0에서 31ms 검증", "v1.3.0에서 7ms 검증");

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "v1.3.0"));
  assert.ok(result.issues.some((issue) => issue.value === "7ms"));
});

test("Korean unit tokens are protected without ASCII word-boundary assumptions", () => {
  const result = validate("3분 동안 5건 검증", "4분 동안 6건 검증");
  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "4분"));
  assert.ok(result.issues.some((issue) => issue.value === "6건"));
});

test("open status requires an as-of date", () => {
  assert.strictEqual(validate("연결 문제 조사", "연결 문제 미해결").status, "FAIL");
  assert.strictEqual(
    validate("연결 문제 조사", "연결 문제 (2026-07-15 기준 미해결)").status,
    "PASS"
  );
});

test("report must start at the configured section header", () => {
  const result = validateReport(
    `${HEADER}\n- 원본\n`,
    `설명입니다.\n${HEADER}\n- 원본\n`,
    { sectionHeader: HEADER }
  );
  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.code === "section_does_not_start_at_header"));
});
