const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { runGenerate } = require("../../index");
const { sha256 } = require("../report-artifact");
const {
  makeFakeClaude,
  setupSnapshot,
} = require("./helpers/report-run-fixture");

const HEADER = '#### <span style="color:blue">조현우</span>';

test("AI-enabled generate stores schema v2 artifacts and promotes only clean Markdown", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  const aiOutput = `설명 머리말\n${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
  assert.strictEqual(result.validation.schemaVersion, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(result.generationStatePath, "utf8")).status, "complete");
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), aiOutput);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.strictEqual(working, `${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(runState.sanitizer.inputHash, sha256(aiOutput));
  assert.strictEqual(runState.sanitizer.outputHash, sha256(working));
  const globalState = JSON.parse(fs.readFileSync(result.generationStatePath, "utf8"));
  assert.strictEqual(globalState.runDir, result.runPaths.runDir);
  assert.strictEqual(globalState.catalogHash, runState.catalogHash);
  assert.strictEqual(globalState.latestValidationPath, "validation.001.json");
  assert.strictEqual(globalState.cleanReportHash, sha256(fs.readFileSync(fixture.reportPath, "utf8")));
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.deepStrictEqual(promptInput, {
    snapshotPath: fixture.snapshotPath,
    snapshotHash: fixture.snapshot.contentHash,
    catalogHash: runState.catalogHash,
    promptHash: promptInput.promptHash,
    model: "sonnet",
    effort: "low",
    promptLength: promptInput.promptLength,
    timeoutMs: 300000,
  });
  assert.match(promptInput.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(promptInput.promptLength > 0);
});

test("v2 validation failure preserves the previous report and never retries Claude", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fs.writeFileSync(fixture.reportPath, "previous valid report\n", "utf8");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T0001|10/11 PASS]]\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8")).status, "validation_failed");
  const globalState = JSON.parse(fs.readFileSync(result.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.latestValidationPath, "validation.001.json");
  assert.strictEqual(Object.hasOwn(globalState, "cleanReportHash"), false);
});

test("v2 AI failure records both failed states and preserves the existing error code without retry", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, "");

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "AI_EMPTY_OUTPUT"
  );

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "AI_EMPTY_OUTPUT");
  const runState = JSON.parse(fs.readFileSync(`${globalState.runDir}/state.json`, "utf8"));
  assert.strictEqual(runState.status, "ai_failed");
  assert.strictEqual(runState.errorCode, "AI_EMPTY_OUTPUT");
});
