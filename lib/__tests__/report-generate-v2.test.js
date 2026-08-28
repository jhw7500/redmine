const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { isPublishable, runGenerate, runGenerateV2 } = require("../../index");
const { sha256 } = require("../report-artifact");
const {
  makeFakeClaude,
  makeSpawnMarker,
  setupSnapshot,
} = require("./helpers/report-run-fixture");

const HEADER = '#### <span style="color:blue">조현우</span>';

test("AI-enabled generate stores schema v2 artifacts and promotes only clean Markdown", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  const aiOutput = `설명 머리말\n${HEADER}\n- 보드 실행 [[fact:T0001]]\n`;
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
  assert.strictEqual(globalState.validationRevision, 1);
  assert.strictEqual(globalState.latestValidationHash, runState.latestValidationHash);
  const validationText = fs.readFileSync(
    path.join(result.runPaths.runDir, "validation.001.json"),
    "utf8"
  );
  assert.strictEqual(JSON.parse(validationText).revision, 1);
  assert.strictEqual(globalState.latestValidationHash, sha256(validationText));
  assert.strictEqual(globalState.cleanReportHash, sha256(fs.readFileSync(fixture.reportPath, "utf8")));
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.deepStrictEqual(promptInput, {
    snapshotPath: fixture.snapshotPath,
    snapshotHash: fixture.snapshot.contentHash,
    catalogHash: runState.catalogHash,
    factInputMode: "inline_refs",
    promptHash: promptInput.promptHash,
    model: "sonnet",
    effort: "low",
    promptLength: promptInput.promptLength,
    timeoutMs: 300000,
  });
  assert.match(promptInput.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(promptInput.promptLength > 0);
  assert.strictEqual(
    runState.promptInputHash,
    sha256(fs.readFileSync(result.runPaths.promptInputPath, "utf8"))
  );
  assert.strictEqual(
    runState.rawAiDraftHash,
    sha256(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"))
  );
  assert.strictEqual(globalState.promptInputHash, runState.promptInputHash);
  assert.strictEqual(globalState.rawAiDraftHash, runState.rawAiDraftHash);
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
  assert.strictEqual(globalState.validationRevision, 1);
  assert.match(globalState.latestValidationHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(Object.hasOwn(globalState, "cleanReportHash"), false);
});

test("v2 leaves an unknown bare reference visible and blocks it as malformed", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T9999]]\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    `${HEADER}\n- 보드 실행 [[fact:T9999]]\n`
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "malformed_fact_marker"
  ));
});

test("v2 blocks a counter appended outside an expanded bare-number reference", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- retire 4 repos\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- retire [[fact:Q0001]]개 repos\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.match(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    /\[\[fact:Q0001\|4\]\]개/
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "4개"
  ));
});

test("fact-reference preflight failure leaves no running run and never starts Claude", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const preflightError = new Error("catalog/source mismatch");
  preflightError.code = "FACT_SOURCE_MISMATCH";

  await assert.rejects(
    () => runGenerateV2(fixture.config, fixture.meetingDate, {
      annotateFactReferences() {
        throw preflightError;
      },
    }),
    (error) => error === preflightError
  );

  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "FACT_SOURCE_MISMATCH");
  assert.strictEqual(fs.existsSync(globalState.runDir), false);
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

test("v2 does not promote an open-status claim without pickaxe evidence", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 연결 안정화 작업\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 연결 안정화 작업 ([[fact:S0001|2026-08-26]] 기준 미완료)\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(result.validation.status, "WARNING");
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "open_status_pickaxe_unavailable"
  ));
  assert.strictEqual(isPublishable(result.validation), false);
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8")).status,
    "validation_failed"
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(result.generationStatePath, "utf8")).status,
    "failed"
  );
});

test("sanitizer interruption preserves raw stdout before working or canonical output", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 완료 항목\n` });
  const aiOutput = `설명 머리말\n${HEADER}\n- 완료 항목\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);
  const interruption = new Error("sanitizer interrupted");
  interruption.code = "SANITIZER_INTERRUPTED";
  Object.defineProperty(fixture.config.env, "sectionHeader", {
    configurable: true,
    get() {
      if (fs.existsSync(fixture.generationStatePath)) {
        const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
        if (state.runDir && fs.existsSync(path.join(state.runDir, "draft.ai.annotated.md"))) {
          throw interruption;
        }
      }
      return HEADER;
    },
  });

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "SANITIZER_INTERRUPTED"
  );

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const rawPath = path.join(globalState.runDir, "draft.ai.annotated.md");
  const workingPath = path.join(globalState.runDir, "draft.working.annotated.md");
  assert.strictEqual(fs.readFileSync(rawPath, "utf8"), aiOutput);
  assert.strictEqual(fs.existsSync(workingPath), false);
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "SANITIZER_INTERRUPTED");
  const runState = JSON.parse(fs.readFileSync(path.join(globalState.runDir, "state.json"), "utf8"));
  assert.strictEqual(runState.status, "ai_failed");
  assert.strictEqual(runState.errorCode, "SANITIZER_INTERRUPTED");
});
