const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  analyzeReport,
  buildComparisonMatrix,
  runComparison,
  selectComparisonMatrix,
} = require("../../scripts/ai-provider-scope-spike");

test("comparison matrix covers Claude Sonnet/Opus and Codex in both scopes", () => {
  assert.deepStrictEqual(
    buildComparisonMatrix().map(({ provider, model, scope }) => ({ provider, model, scope })),
    [
      { provider: "claude", model: "sonnet", scope: "whole" },
      { provider: "claude", model: "sonnet", scope: "project" },
      { provider: "claude", model: "opus", scope: "whole" },
      { provider: "claude", model: "opus", scope: "project" },
      { provider: "codex", model: "gpt-5.6-sol", scope: "whole" },
      { provider: "codex", model: "gpt-5.6-sol", scope: "project" },
    ]
  );
});

test("comparison matrix can select explicit candidates without adding calls", () => {
  assert.deepStrictEqual(
    selectComparisonMatrix("claude-sonnet-project,codex-gpt-5.6-sol-project")
      .map((entry) => entry.id),
    ["claude-sonnet-project", "codex-gpt-5.6-sol-project"]
  );
  assert.throws(() => selectComparisonMatrix("unknown"), /Unknown comparison id/);
});

test("report analysis finds normalized duplicate bullets without merging content", () => {
  const analysis = analyzeReport([
    "#### 조현우",
    "- PIM",
    "  - 최종 검증 완료",
    "- ETC",
    "  -   최종   검증 완료  ",
    "  - 서로 다른 기능",
    "",
  ].join("\n"));

  assert.strictEqual(analysis.lineCount, 6);
  assert.strictEqual(analysis.bulletCount, 5);
  assert.deepStrictEqual(analysis.duplicateGroups, [{
    text: "최종 검증 완료",
    count: 2,
    lines: [3, 5],
  }]);
});

test("report analysis does not count repeated structural headings as duplicate work", () => {
  const analysis = analyzeReport([
    "#### 조현우",
    "- PIM",
    "  - Application",
    "    - PIM 결과",
    "- Wireless Lan",
    "  - Application",
    "    - WLAN 결과",
    "",
  ].join("\n"));

  assert.deepStrictEqual(analysis.duplicateGroups, []);
});

test("comparison runs each matrix entry once and records failures without retry", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-ai-spike-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const calls = [];
  const matrix = [
    { id: "first", provider: "claude", model: "sonnet", scope: "whole" },
    { id: "second", provider: "codex", model: "gpt-5.6-sol", scope: "project" },
  ];
  const baseConfig = {
    env: { sectionHeader: "#### 조현우" },
    repos: {},
  };

  const summary = await runComparison({
    baseConfig,
    matrix,
    meetingDate: new Date("2026-08-26T00:00:00+09:00"),
    meetingDateText: "2026-08-26",
    outputRoot: tempDir,
    snapshotPath: "/sealed/snapshot.json",
    runGenerateFn: async (config) => {
      calls.push({
        provider: config.env.aiProvider,
        model: config.env.aiModel,
        scope: config.env.aiGenerationScope,
      });
      if (config.env.aiProvider === "codex") {
        const error = new Error("candidate failed");
        error.code = "AI_FAILED";
        error.partId = "PIM";
        error.issues = [{ severity: "error", code: "fact_subject_mismatch" }];
        throw error;
      }
      fs.mkdirSync(path.dirname(config.env.outputPath), { recursive: true });
      fs.writeFileSync(config.env.outputPath, "#### 조현우\n- PIM\n  - 완료\n", "utf8");
      return {
        reportPath: config.env.outputPath,
        validation: {
          status: "PASS",
          publishable: true,
          issues: [],
          sourceCoverage: { complete: true },
        },
      };
    },
  });

  assert.deepStrictEqual(calls, [
    { provider: "claude", model: "sonnet", scope: "whole" },
    { provider: "codex", model: "gpt-5.6-sol", scope: "project" },
  ]);
  assert.strictEqual(summary.results[0].status, "PASS");
  assert.strictEqual(summary.results[0].bulletCount, 2);
  assert.strictEqual(summary.results[1].status, "ERROR");
  assert.strictEqual(summary.results[1].errorCode, "AI_FAILED");
  assert.strictEqual(summary.results[1].partId, "PIM");
  assert.deepStrictEqual(summary.results[1].validationIssues.byCode, {
    fact_subject_mismatch: 1,
  });
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(tempDir, "comparison.json"), "utf8")).results.length,
    2
  );
});
