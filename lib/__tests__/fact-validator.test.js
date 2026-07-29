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

test("seconds and byte units are protected facts", () => {
  const result = validate("3초 동안 500KB 처리", "4초 동안 600KB 처리");
  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "4초"));
  assert.ok(result.issues.some((issue) => issue.value === "600kb"));
});

test("generic counter rewording of the same number is supported", () => {
  // 원본이 "3방안"처럼 숫자+명사로 센 것을 요약이 "3개 방안"으로 풀어 쓰는 것은
  // 수치 날조가 아니라 조수사 표기 차이다. 숫자가 같으면 통과해야 한다.
  assert.strictEqual(validate("MAC/Port축 3방안뿐", "MAC/Port 축 3개 방안만 유효").status, "PASS");
  assert.strictEqual(
    validate("CFI 3캠페인 85 pcap 보정", "CFI 3개 캠페인 85 pcap 적용").status,
    "PASS"
  );
});

test("generic counter with a number absent from the source is still rejected", () => {
  const result = validate("MAC/Port축 3방안뿐", "MAC/Port 축 5개 방안만 유효");

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "5개"));
});

test("underline tags inside Markdown code do not affect markup balance", () => {
  assert.strictEqual(
    validate("태그 사용법 설명", "태그 사용법: `<u>`\n```html\n<u>\n```").status,
    "PASS"
  );

  const result = validate("태그 사용법 설명", "<u>태그 사용법 설명");
  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.code === "underline_unbalanced"));
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
