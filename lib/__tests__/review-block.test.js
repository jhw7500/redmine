const { test } = require("node:test");
const assert = require("node:assert");
const { buildReviewBlock } = require("../review-block");

const failedEntry = (extra = {}) => ({
  status: "failed",
  primaryIssueCode: "open_status_without_as_of",
  issueCounts: { open_status_without_as_of: 2, missing_source_id: 34 },
  rejectedReportPath: "x",
  rejectedReportHash: "h",
  validationPath: "v",
  pipelineAttemptId: "p",
  ...extra,
});

const err = (line, code = "open_status_without_as_of") => ({ severity: "error", code, line });
const warn = (line) => ({ severity: "warning", code: "missing_source_id", line });

test("no failures and no drops yields an empty block", () => {
  assert.strictEqual(
    buildReviewBlock({
      published: { variant: "2", status: "ready" },
      variants: { 2: { status: "ready", reportHash: "h" } },
      summary: { status: "ready" },
      droppedEvidence: [],
    }),
    "",
  );
  assert.strictEqual(buildReviewBlock({ published: { variant: "2", status: "ready" } }), "");
});

test("a failed variant lists its codes, counts and error lines", () => {
  const issues = [err("오류 줄 하나"), err("오류 줄 둘")];
  for (let i = 0; i < 34; i += 1) issues.push(warn(`경고 줄 ${i}`));
  const block = buildReviewBlock({
    published: { variant: "2", status: "failed" },
    variants: { 2: { ...failedEntry(), issues } },
    droppedEvidence: [],
  });
  assert.match(block, /^\*\*검토 필요\(자동\)\*\*/);
  assert.match(block, /- 게시본: 2 \(검증 실패 그대로 게시\)/);
  assert.match(block, /open_status_without_as_of 2/);
  assert.match(block, /missing_source_id 34/);
  assert.ok(block.includes("`오류 줄 하나`"));
  assert.ok(block.includes("`오류 줄 둘`"));
  assert.ok(!block.includes("경고 줄"));
});

test("excerpts are capped at 20 per variant and 200 characters", () => {
  const issues = [];
  for (let i = 0; i < 25; i += 1) issues.push(err(`L${i}-${"가".repeat(300)}`));
  const block = buildReviewBlock({
    published: { variant: "3", status: "failed" },
    variants: { 3: { ...failedEntry(), issues } },
  });
  const excerpts = block.split("\n").filter((l) => l.startsWith("  - `"));
  assert.strictEqual(excerpts.length, 20);
  for (const l of excerpts) {
    const body = l.slice("  - `".length, -1);
    assert.ok([...body].length <= 200);
  }
});

test("a header-like or blue-span excerpt cannot add a section header", () => {
  const block = buildReviewBlock({
    published: { variant: "2", status: "failed" },
    variants: {
      2: { ...failedEntry(), issues: [err('#### <span style="color:blue">조현우</span>'), err("a`b`c")] },
    },
    droppedEvidence: [],
  });
  assert.strictEqual(block.split('#### <span style="color:blue">').length - 1, 0);
  assert.ok(!block.split("\n").some((l) => l.startsWith("#")));
  assert.ok(!block.includes("<span"));
  const ex = block.split("\n").filter((l) => l.startsWith("  - `"));
  for (const l of ex) assert.strictEqual((l.match(/`/g) || []).length, 2);
});

test("dropped evidence is listed by repo, ref and kind only", () => {
  const block = buildReviewBlock({
    published: { variant: "2", status: "ready" },
    variants: { 2: { status: "ready" } },
    droppedEvidence: [{ source: "git_commit", repo: "org/repo", ref: "abc1234", kind: "commit" }],
  });
  assert.match(block, /- 수집 제외: org\/repo abc1234 \(commit\)/);
  assert.match(block, /- 게시본: 2 \(통과\)/);
  assert.ok(!block.includes("git_commit"));
});

test("a failed summary shows status, reason and blocking codes with lines", () => {
  const block = buildReviewBlock({
    published: { variant: "summary", status: "failed" },
    variants: {},
    summary: { status: "failed", reason: "gate_blocked", gate: { blocking: [{ code: "x_code", line: 7 }] } },
  });
  assert.ok(block.includes("failed"));
  assert.ok(block.includes("gate_blocked"));
  assert.ok(block.includes("x_code (line 7)"));
});

test("a failed summary lists its own error lines like a failed variant, never message or evidence", () => {
  const issues = [
    { ...err("요약 오류 줄"), message: "MESSAGE-TEXT", evidence: "EVIDENCE-TEXT" },
    warn("요약 경고 줄"),
  ];
  for (let i = 0; i < 25; i += 1) issues.push(err(`S${i}-${"나".repeat(300)}`));
  const block = buildReviewBlock({
    published: { variant: "summary", status: "failed" },
    variants: {},
    summary: { status: "failed", reason: "VALIDATION_FAILED", gate: null, issues },
  });
  const lines = block.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- 요약: "));
  assert.ok(at >= 0, block);
  const excerpts = lines.slice(at + 1).filter((l) => l.startsWith("  - `"));
  assert.strictEqual(excerpts.length, 20);
  assert.strictEqual(excerpts[0], "  - `요약 오류 줄`");
  for (const l of excerpts) assert.ok([...l.slice("  - `".length, -1)].length <= 200);
  assert.ok(!block.includes("요약 경고 줄"));
  assert.ok(!block.includes("MESSAGE-TEXT"));
  assert.ok(!block.includes("EVIDENCE-TEXT"));
});
