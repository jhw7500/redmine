const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractCountedQuantityOccurrences,
  extractProtectedTokenOccurrences,
  extractTestFactOccurrences,
  extractTestFacts,
  validateReport,
} = require("../fact-validator");

const HEADER = '#### <span style="color:blue">조현우</span>';

function validate(rawLine, outputLine) {
  return validateReport(
    `${HEADER}\n- ${rawLine}\n`,
    `${HEADER}\n- ${outputLine}\n`,
    { sectionHeader: HEADER, meetingDate: "2026-07-15", reportDepth: 3 }
  );
}

test("occurrence scanners retain source offsets without changing legacy facts", () => {
  const source = "첫줄\n보드 실행 5/8 PASS, 플릿 16건 저장소 배포와 31ms 검증";

  assert.deepStrictEqual(extractTestFactOccurrences(source)[0], {
    pass: 5,
    total: 8,
    fail: 3,
    raw: "5/8 PASS",
    start: 9,
    end: 17,
    line: 2,
    column: 7,
  });
  assert.deepStrictEqual(extractTestFacts(source)[0], {
    pass: 5,
    total: 8,
    fail: 3,
    raw: "5/8 PASS",
  });
  assert.deepStrictEqual(extractCountedQuantityOccurrences(source)[0], {
    raw: "16건",
    token: "16건",
    key: "16 저장소",
    subject: "저장소",
    start: 22,
    end: 25,
    line: 2,
    column: 20,
  });
  assert.deepStrictEqual(
    extractProtectedTokenOccurrences(source).find((occurrence) => occurrence.normalized === "31ms"),
    {
      raw: "31ms",
      normalized: "31ms",
      start: 34,
      end: 38,
      line: 2,
      column: 32,
    }
  );
});

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

test("test counts beyond safe integer precision are rejected", () => {
  const hugePass = "999999999999999999999999999999";
  const hugeTotal = "999999999999999999999999999998";
  const result = validate(
    `실타깃 ${hugePass}/${hugeTotal} PASS`,
    `실타깃 ${hugePass}/${hugeTotal} PASS`
  );

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.code === "unsafe_test_count"));
});

test("invented protected numbers and versions are rejected", () => {
  const result = validate("v1.2.0에서 31ms 검증", "v1.3.0에서 7ms 검증");

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "v1.3.0"));
  assert.ok(result.issues.some((issue) => issue.value === "7ms"));
});

test("version v-prefix is notation, not a fabricated fact", () => {
  // 원본 "version 3.0"을 요약이 "v3.0"으로 써서 게시가 막혔다 (2026-08-12 주간 보고).
  assert.strictEqual(validate("gstApp version 3.0 릴리스", "gstApp v3.0 릴리스").status, "PASS");
  // 반대 방향(원본 v1.34 → 요약 1.34)도 같은 버전이므로 통과해야 한다.
  assert.strictEqual(validate("v1.34 배포 완료", "1.34 배포 완료").status, "PASS");
  // 접두를 무시해도 버전 숫자가 다르면 여전히 막는다.
  assert.strictEqual(validate("gstApp version 3.0 릴리스", "gstApp v3.1 릴리스").status, "FAIL");
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

test("generic counter must match what was counted, not just the digit", () => {
  // 같은 숫자가 원본 어딘가에 있다는 이유만으로 통과시키면 요약이 수치를 지어낼 수 있다.
  const unrelated = validate("3분 동안 점검", "신규 문제 3건 발견");
  assert.strictEqual(unrelated.status, "FAIL");
  assert.ok(unrelated.issues.some((issue) => issue.value === "3건"));

  // 날짜에서 유래한 숫자도 수량의 근거가 될 수 없다.
  const fromDate = validate("2026년 7월 29일 점검 완료", "이슈 7건 발생");
  assert.strictEqual(fromDate.status, "FAIL");
  assert.ok(fromDate.issues.some((issue) => issue.value === "7건"));
});

test("nouns that merely share a prefix are not the same counted target", () => {
  // 앞 2글자만 키로 쓰면 "프로젝트"와 "프로그램", "검사"와 "검토"가 같은 키가 되어
  // 서로 다른 대상을 센 수치가 조수사 예외를 타고 통과한다.
  assert.strictEqual(validate("3프로젝트 완료", "3개 프로그램 완료").status, "FAIL");
  assert.strictEqual(validate("3검사 수행", "3개 검토 수행").status, "FAIL");
});

test("a counter glued into a compound word is not a counter", () => {
  // "3개월"의 "개"는 조수사가 아니라 "개월"의 일부다.
  // 원본의 "3월"(March)이 요약의 "3개월"(3 months) 근거가 되면 안 된다.
  const result = validate("3월 점검 완료", "3개월 후 완료 예정");

  assert.strictEqual(result.status, "FAIL");
  assert.ok(result.issues.some((issue) => issue.value === "3개"));
});

test("a counter followed by 의 still counts the noun after it", () => {
  assert.strictEqual(validate("MAC/Port축 3방안뿐", "MAC/Port 축 3개의 방안만 유효").status, "PASS");
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
