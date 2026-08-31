const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeOpenStatusAsOfClauses } = require("../open-status-normalizer");

const MEETING_DATE_FACT = {
  id: "S0001",
  type: "meeting_date",
  raw: "2026-08-26",
};

test("moves only the known 미수정 note outside an as-of parenthesis", () => {
  const input = [
    "- killcam 오탐 문제 (미수정, [[fact:S0001|2026-08-26]] 기준 미해결)",
    "- 후속 작업 (미수정, [[fact:S0001|2026-08-26]] 기준 미완료)",
  ].join("\n");

  assert.strictEqual(normalizeOpenStatusAsOfClauses(input), [
    "- killcam 오탐 문제 미수정 ([[fact:S0001|2026-08-26]] 기준 미해결)",
    "- 후속 작업 미수정 ([[fact:S0001|2026-08-26]] 기준 미완료)",
  ].join("\n"));
});

test("does not infer or rewrite an incomplete or unknown open-status clause", () => {
  const cases = [
    "- 문제 (미수정, 기준 미해결)",
    "- 문제 (추정, [[fact:S0001|2026-08-26]] 기준 미해결)",
    "- 문제 (미수정, [[fact:S0001|2026-08-26]])",
    "- 문제 미해결",
  ];

  for (const input of cases) {
    assert.strictEqual(normalizeOpenStatusAsOfClauses(input), input);
  }
});

test("adds the meeting-date system fact to a bare known open status", () => {
  const input = "- 관련 PR 즉시 배포는 보류하고 정규 릴리스에 편승 확정";

  assert.strictEqual(
    normalizeOpenStatusAsOfClauses(input, MEETING_DATE_FACT),
    "- 관련 PR 즉시 배포는 ([[fact:S0001|2026-08-26]] 기준 보류)하고 정규 릴리스에 편승 확정"
  );
});

test("does not duplicate an existing exact as-of clause", () => {
  const cases = [
    "- 관련 PR 즉시 배포는 ([[fact:S0001|2026-08-26]] 기준 보류)",
    "- 이전 점검부터 ([[fact:V0001|2026-05-08]] 기준 미해결)",
    "- 관련 PR 즉시 배포는 (2026-08-26 기준 보류)",
  ];

  for (const input of cases) {
    assert.strictEqual(normalizeOpenStatusAsOfClauses(input, MEETING_DATE_FACT), input);
  }
});

test("leaves bare statuses unchanged without a valid meeting-date system fact", () => {
  const input = "- 관련 PR 즉시 배포 보류";
  const invalidFacts = [
    undefined,
    { id: "T0001", type: "meeting_date", raw: "2026-08-26" },
    { id: "S0001", type: "report_date", raw: "2026-08-26" },
    { id: "S0001", type: "meeting_date", raw: "2026/08/26" },
  ];

  for (const fact of invalidFacts) {
    assert.strictEqual(normalizeOpenStatusAsOfClauses(input, fact), input);
  }
});

test("does not infer a status from TODO or FIXME", () => {
  const input = [
    "- 배포 TODO",
    "- 호환성 확인 FIXME",
  ].join("\n");

  assert.strictEqual(normalizeOpenStatusAsOfClauses(input, MEETING_DATE_FACT), input);
});
