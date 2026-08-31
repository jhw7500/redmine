const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeOpenStatusAsOfClauses } = require("../open-status-normalizer");

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
