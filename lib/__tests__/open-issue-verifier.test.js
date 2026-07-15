const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractOpenStatusClaims,
  verifyOpenIssueClaims,
} = require("../open-issue-verifier");

test("extracts an as-of date and pickaxe symbol", () => {
  const [claim] = extractOpenStatusClaims(
    "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)"
  );
  assert.strictEqual(claim.asOf, "2026-05-08");
  assert.ok(claim.symbols.includes("arg.cam[i].bps"));
});

test("hidden chore commit found by pickaxe requires review", () => {
  const calls = [];
  const result = verifyOpenIssueClaims(
    "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)",
    { gstApp: { path: "/repo/gstApp" } },
    {
      runGit: (_path, args) => {
        calls.push(args);
        if (args.includes("-S")) {
          return { ok: true, stdout: "dc06098\tchore: 빌드 디렉토리 정리\n", error: null };
        }
        return { ok: true, stdout: "", error: null };
      },
    }
  );

  assert.ok(calls.some((args) => args.includes("-S")));
  assert.ok(calls.every((args) => args.includes("--since=2026-05-08T00:00:00+09:00")));
  assert.ok(result.issues.some((issue) => issue.code === "open_status_resolution_evidence"));
});

test("a claim without a code symbol cannot pass the automatic publish gate", () => {
  const result = verifyOpenIssueClaims(
    "- 연결 안정화 작업 (2026-07-15 기준 미완료)",
    {},
    { runGit: () => ({ ok: true, stdout: "", error: null }) }
  );
  assert.ok(result.issues.some((issue) => issue.code === "open_status_pickaxe_unavailable"));
});
