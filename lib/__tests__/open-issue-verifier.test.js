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

test("extracts each top-level open-status clause with independent date and symbol", () => {
  const claims = extractOpenStatusClaims(
    "- `first.symbol` 오류 (2026-08-28 기준 미해결); `second.symbol` 오류 (2026-05-01 기준 미해결)"
  );

  assert.deepStrictEqual(claims.map((claim) => claim.asOf), ["2026-08-28", "2026-05-01"]);
  assert.deepStrictEqual(claims.map((claim) => claim.symbols), [["first.symbol"], ["second.symbol"]]);

  const calls = [];
  verifyOpenIssueClaims(
    "- `first.symbol` 오류 (2026-08-28 기준 미해결); `second.symbol` 오류 (2026-05-01 기준 미해결)",
    { app: { path: "/repo/app" } },
    {
      runGit: (_path, args) => {
        calls.push(args);
        return { ok: true, stdout: "", error: null };
      },
    }
  );
  const secondPickaxe = calls.find((args) => args.includes("-S") && args.includes("second.symbol"));
  assert.ok(secondPickaxe);
  assert.ok(secondPickaxe.includes("--since=2026-05-01T00:00:00+09:00"));
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

test("a failed pickaxe check is visible in validation issues", () => {
  const result = verifyOpenIssueClaims(
    "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)",
    { gstApp: { path: "/repo/gstApp" } },
    {
      runGit: (_path, args) => args.includes("-S")
        ? { ok: false, stdout: "", error: "git failed" }
        : { ok: true, stdout: "", error: null },
    }
  );

  assert.ok(result.issues.some((issue) => issue.code === "open_status_git_pickaxe_failed"));
});

test("an unavailable configured repository fails closed instead of skipping verification", () => {
  let gitCalls = 0;
  const result = verifyOpenIssueClaims(
    "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)",
    {},
    {
      unavailableRepos: {
        gstApp: {
          path: "/missing/gstApp",
          gitPath: "/missing/gstApp/.git",
          reason: ".git entry not found",
        },
      },
      runGit: () => {
        gitCalls += 1;
        return { ok: true, stdout: "", error: null };
      },
    }
  );

  assert.strictEqual(gitCalls, 0);
  assert.ok(result.issues.some((issue) =>
    issue.severity === "error"
      && issue.code === "open_status_repo_unavailable"
      && issue.repo === "gstApp"
  ));
  assert.deepStrictEqual(result.checks[0].repos, [{
    repo: "gstApp",
    path: "/missing/gstApp",
    available: false,
    error: ".git entry not found",
  }]);
});
