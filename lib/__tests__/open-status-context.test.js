const { test } = require("node:test");
const assert = require("node:assert");
const { validateReport } = require("../fact-validator");
const { extractOpenStatusClaims, verifyOpenIssueClaims } = require("../open-issue-verifier");
const { normalizeOpenStatusAsOfClauses } = require("../open-status-normalizer");
const { findOpenStatusOccurrences } = require("../open-status-clauses");

const HEADER = '#### <span style="color:blue">조현우</span>';
const DATE_FACT = { id: "S0001", type: "meeting_date", raw: "2026-10-21" };
const validate = line => validateReport(`${HEADER}\n${line}\n`, `${HEADER}\n${line}\n`, {
  sectionHeader: HEADER, meetingDate: "2026-10-21", reportDepth: 3,
});

const DESCRIPTIONS = [
  "- 재기동 직후 첫 조각 전에는 파일 검사를 보류해 거짓 누락 재시작을 막는다",
  "↳ 목적: 첫 조각 신호가 아직 없고 앱이 `init_cooldown_sec`보다 어리면 그 세션은 판정하지 않는다. 앱이 없을 때와 보류가…",
  "↳ 변경: 다음 셋이 모두 맞으면 0(보류)을 돌려주고 notice",
  "- FSYNC 상태를 펄스 잠금 안에서 기록하고 소유자 전용 보류를 없앤다",
  "#130 설계의 보류 표현 규칙을 더한 것이다.…",
  "원문이 이미 내린 결정을 미완료 표현으로 바꾸지 않고 원문에 없는 미완료·후속 표현을 만들지 않음",
  "재연결할 때 알림 전송을 보류해 중복 통지를 방지한다",
  "재연결 시 알림 전송을 보류해 중복 통지를 방지한다",
  "단일 채널 전용 보류를 제거했다",
  "- 미완료 상태의 임의 생성 방지와 개인 운영 자동화의 ETC 분류 지침 보강",
  "- (2026-10-21 기준 미완료) 상태의 임의 생성 방지와 개인 운영 자동화의 ETC 분류 지침 보강",
  "- 미해결 상태의 임의 생성 방지를 위한 보고서 작성 규칙 보강",
  "- 재기동 직후 첫 녹화 조각이 생성되기 전까지 파일 검사를 보류해 거짓 누락 판정과 불필요한 단계별 복구 방지",
  "- 재기동 직후 첫 녹화 조각이 생성되기 전까지 파일 검사를 (2026-10-21 기준 보류)해 거짓 누락 판정과 불필요한 단계별 복구 방지",
];

test("runtime behavior and writing rules do not assert unfinished work", async t => {
  for (const line of DESCRIPTIONS) {
    await t.test(line, () => {
      assert.deepStrictEqual(validate(line).issues.filter(issue => issue.code.startsWith("open_status_")), []);
      assert.deepStrictEqual(extractOpenStatusClaims(line), []);
      assert.strictEqual(normalizeOpenStatusAsOfClauses(line, DATE_FACT), line);
    });
  }
});

test("ambiguous, planned, and negated status claims still require verification", async t => {
  const claims = [
    "- 파일 검사 보류",
    "- 첫 조각 검사는 보류할 예정",
    "- 향후 FSYNC 소유자 전용 보류를 없앤다",
    "- 내일 FSYNC 소유자 전용 보류를 없앤다",
    "- 다음 주 FSYNC 소유자 전용 보류를 제거한다",
    "- 곧 FSYNC 소유자 전용 보류를 없앤다",
    "- 이번 주 FSYNC 소유자 전용 보류를 없앤다",
    "- 오는 주말 FSYNC 소유자 전용 보류를 없앤다",
    "- 조만간 FSYNC 소유자 전용 보류를 없앤다",
    "- FSYNC 소유자 전용 보류를 나중에 없앤다",
    "- FSYNC 소유자 전용 보류를 없애지 못했다",
    "- FSYNC 보류를 제거했다. 사실이 아니다",
    "- FSYNC 보류를 제거했다(사실 아님)",
    "- FSYNC 소유자 전용 보류 제거가 미완료",
    "- 앱이 없을 때와 보류가…",
    "- 로그를 고쳤다. 앱 배포 보류가…",
    "내일 첫 조각 신호가 아직 없고 앱이 `init_cooldown_sec`보다 어리면 그 세션은 판정하지 않는다. 앱이 없을 때와 보류가…",
    "- 미완료 문구로 현재 상태를 기록했다",
    "- 보고서의 보류 표현 규칙이 미완료다",
    "- `TODO` 표현 규칙을 추가했다",
    "- `FIXME` 문구를 설명했다",
    "- 미완료 상태의 임의 생성 방지 기능 구현",
    "- 재기동 직후 첫 조각 전까지 파일 검사를 보류해 오검출 방지 예정",
  ];
  for (const line of claims) {
    await t.test(line, () => {
      assert.ok(validate(line).issues.some(issue => issue.code === "open_status_without_as_of"));
      assert.ok(extractOpenStatusClaims(line).length > 0);
    });
  }
});

test("release work deferral remains an actual claim through normalization and git verification", () => {
  const line = "- 릴리즈 전까지 수정 작업을 보류해 배포 위험 방지; 장비 검증 미완료";
  assert.deepStrictEqual(findOpenStatusOccurrences(line).map(({ term }) => term), ["보류", "미완료"]);
  assert.ok(validate(line).issues.some(issue => issue.code === "open_status_without_as_of"));
  assert.strictEqual(extractOpenStatusClaims(line).length, 2);
  assert.strictEqual(normalizeOpenStatusAsOfClauses(line, DATE_FACT),
    "- 릴리즈 전까지 수정 작업을 ([[fact:S0001|2026-10-21]] 기준 보류)해 배포 위험 방지; 장비 검증 ([[fact:S0001|2026-10-21]] 기준 미완료)");

  const calls = [];
  const dated = "- 릴리즈 전까지 수정 작업을 (2026-10-21 기준 보류)해 배포 위험 방지";
  const result = verifyOpenIssueClaims(dated, { app: { path: "/repo/app" } }, {
    runGit: (_path, args) => {
      calls.push(args);
      return { ok: true, stdout: "", error: null };
    },
  });
  assert.strictEqual(result.checks.length, 1);
  assert.ok(calls.some(args => args.includes("--since=2026-10-21T00:00:00+09:00")));
});

test("repeated clipped clauses cannot borrow an earlier runtime condition", () => {
  const line = "첫 조각 신호가 아직 없고 앱이 `init_cooldown_sec`보다 어리면 그 세션은 판정하지 않는다. 앱이 없을 때와 보류가…; 앱이 없을 때와 보류가…";
  assert.deepStrictEqual(validate(line).issues.filter(issue => issue.code === "open_status_without_as_of")
    .map(issue => issue.line), ["앱이 없을 때와 보류가…"]);
  assert.strictEqual(extractOpenStatusClaims(line).length, 1);
});

test("descriptive mentions cannot hide an actual claim in the same clause", async t => {
  const claims = [
    `${DESCRIPTIONS[0]} 그리고 실기 검증 미완료`,
    `${DESCRIPTIONS[2]} 그리고 배포 보류`,
    `${DESCRIPTIONS[3]} 하지만 연동 오류 미해결`,
    "보고서의 보류 표현 규칙을 수정했지만 배포 보류",
    `${DESCRIPTIONS[5]} 그리고 코드 FIXME`,
    "- 미완료 상태의 임의 생성 방지 지침은 보강했지만 장비 검증 미완료",
    "- (2026-10-21 기준 미완료) 상태의 임의 생성 방지 규칙 보강, 장비 검증 미완료",
    "- 재기동 직후 첫 조각 전까지 파일 검사를 보류해 오검출 방지; 장비 검증 미완료",
  ];
  for (const line of claims) {
    await t.test(line, () => {
      assert.ok(validate(line).issues.some(issue => issue.code === "open_status_without_as_of"));
      assert.ok(extractOpenStatusClaims(line).length > 0);
    });
  }
});

test("status occurrences preserve independent claims and their original offsets", () => {
  assert.deepStrictEqual(findOpenStatusOccurrences("보류 표현 규칙이 미완료다"), [
    { term: "미완료", start: 10, end: 13 },
  ]);
  assert.deepStrictEqual(findOpenStatusOccurrences("FSYNC 소유자 전용 보류 제거가 미완료"), [
    { term: "보류", start: 13, end: 15 },
    { term: "미완료", start: 20, end: 23 },
  ]);
});

test("date normalization changes actual claims while preserving descriptive mentions", () => {
  const line = "보고서의 보류 표현 규칙을 수정했지만 배포 보류";
  assert.strictEqual(normalizeOpenStatusAsOfClauses(line, DATE_FACT),
    "보고서의 보류 표현 규칙을 수정했지만 배포 ([[fact:S0001|2026-10-21]] 기준 보류)");
});

test("actual dated claims still check titles and code-symbol history", () => {
  const line = "0(보류)을 반환한다; `pending_setting` 조정 (2026-10-21 기준 미완료)";
  const calls = [];
  const result = verifyOpenIssueClaims(line, { app: { path: "/repo/app" } }, {
    runGit: (_path, args) => {
      calls.push(args);
      return { ok: true, stdout: "", error: null };
    },
  });
  assert.strictEqual(result.checks.length, 1);
  assert.strictEqual(result.checks[0].line, "`pending_setting` 조정 (2026-10-21 기준 미완료)");
  assert.ok(calls.some(args => !args.includes("-S")));
  assert.ok(calls.some(args => args.includes("-S") && args.includes("pending_setting")));
});
