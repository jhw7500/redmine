const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runGenerate, runRevalidate } = require("../../index");
const { sealSnapshot, sha256, writeJsonAtomic } = require("../report-artifact");
const { buildRunPaths } = require("../report-run");
const {
  makeFakeClaude,
  makeSpawnMarker,
  setupFailedV2Run,
  setupSnapshot,
} = require("./helpers/report-run-fixture");

const HEADER = '#### <span style="color:blue">조현우</span>';
const PROJECT_ROOT = path.resolve(__dirname, "../..");

test("revalidate promotes a corrected working draft without spawning Claude", async (t) => {
  const fixture = await setupFailedV2Run(t);
  fs.writeFileSync(
    fixture.runPaths.workingDraftPath,
    `${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`,
    "utf8"
  );
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  fixture.config.env.runId = fixture.attemptId;

  const result = await runRevalidate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
  const state = JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8"));
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const validationText = fs.readFileSync(
    `${fixture.runPaths.runDir}/validation.002.json`,
    "utf8"
  );
  assert.strictEqual(state.validationRevision, 2);
  assert.strictEqual(globalState.validationRevision, 2);
  assert.strictEqual(JSON.parse(validationText).revision, 2);
  assert.strictEqual(state.latestValidationHash, sha256(validationText));
  assert.strictEqual(globalState.latestValidationHash, state.latestValidationHash);
});

test("revalidate rejects an invalid run id before reading or spawning", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fixture.config.env.runId = "../../escape";
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);

  await assert.rejects(
    () => runRevalidate(fixture.config, fixture.meetingDate),
    /UUID/
  );
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
});

test("revalidate rejects a replacement snapshot bound to the same path", async (t) => {
  const fixture = await setupFailedV2Run(t);
  const changed = sealSnapshot({
    ...fixture.snapshot,
    rawContent: `${HEADER}\n- 교체된 9/9 PASS\n`,
  });
  writeJsonAtomic(fixture.snapshotPath, changed);
  fixture.config.env.runId = fixture.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);

  await assert.rejects(
    () => runRevalidate(fixture.config, fixture.meetingDate),
    /snapshot hash mismatch/i
  );
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
});

test("revalidate leaves the canonical report untouched when validation still fails", async (t) => {
  const fixture = await setupFailedV2Run(t);
  fs.writeFileSync(fixture.reportPath, "previous valid report\n", "utf8");
  fixture.config.env.runId = fixture.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);

  const result = await runRevalidate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  const state = JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8"));
  assert.strictEqual(state.status, "validation_failed");
  assert.strictEqual(state.validationRevision, 2);
});

test("revalidate CLI exits 2 when block-mode validation still fails", async (t) => {
  const fixture = await setupFailedV2Run(t);
  const child = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "index.js")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MODE: "revalidate",
      MEETING_DATE: "2026-08-26",
      RUN_ID: fixture.attemptId,
      OUTPUT_DIR: fixture.dir,
      OUTPUT_PATH: fixture.reportPath,
      SNAPSHOT_PATH: fixture.snapshotPath,
      REPORT_DEPTH: "3",
      VALIDATION_MODE: "block",
      PRESENTATION_NOTE_MODE: "off",
      AI_SUMMARIZE: "0",
      AUTO_APPROVE: "0",
    },
    encoding: "utf8",
  });

  assert.strictEqual(child.signal, null);
  assert.strictEqual(child.status, 2, child.stderr || child.stdout);
});

test("revalidate rejects a superseded global state without spawning Claude", async (t) => {
  const fixture = await setupFailedV2Run(t);
  const global = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  writeJsonAtomic(fixture.generationStatePath, {
    ...global,
    attemptId: "22222222-2222-4222-8222-222222222222",
  });
  fixture.config.env.runId = fixture.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);

  await assert.rejects(
    () => runRevalidate(fixture.config, fixture.meetingDate),
    /generation superseded/i
  );
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
});

test("a held run-validation lock blocks revalidation before validation-side work", async (t) => {
  const fixture = await setupFailedV2Run(t);
  fixture.config.env.runId = fixture.attemptId;
  let validationConfigReads = 0;
  Object.defineProperty(fixture.config.env, "sectionHeader", {
    configurable: true,
    get() {
      validationConfigReads += 1;
      return HEADER;
    },
  });
  fs.writeFileSync(path.join(fixture.runPaths.runDir, ".validation.lock"), "held", "utf8");

  await assert.rejects(
    () => runRevalidate(fixture.config, fixture.meetingDate),
    (error) => error.code === "RUN_VALIDATION_LOCKED"
  );

  const state = JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8"));
  assert.strictEqual(validationConfigReads, 0);
  assert.strictEqual(state.status, "validation_failed");
  assert.strictEqual(state.validationRevision, 1);
  assert.strictEqual(
    fs.existsSync(path.join(fixture.runPaths.runDir, "validation.002.json")),
    false
  );
});

test("validation throw after durable AI output is recoverable without another Claude call", async (t) => {
  const rawContent = `${HEADER}\n- \`arg.cam[i].bps\` 오류 ([[fact:V0001|2026-05-08]] 기준 미해결)\n`;
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- \`arg.cam[i].bps\` 오류 (2026-05-08 기준 미해결)\n`,
  });
  fs.writeFileSync(fixture.reportPath, "previous canonical\n", "utf8");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, rawContent);
  fixture.config.repos = { gstApp: { path: "/fixture/gstApp" } };
  const interrupted = new Error("git validation interrupted");
  interrupted.code = "OPEN_ISSUE_CHECK_INTERRUPTED";
  let shouldThrow = true;
  fixture.config.openIssueVerifierOptions = {
    runGit: () => {
      if (shouldThrow) throw interrupted;
      return { ok: true, stdout: "", error: null };
    },
  };

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "OPEN_ISSUE_CHECK_INTERRUPTED"
  );

  const globalFailed = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const runPaths = buildRunPaths(fixture.config.env.outputDir, "2026-08-26", globalFailed.attemptId);
  const runFailed = JSON.parse(fs.readFileSync(runPaths.statePath, "utf8"));
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(runPaths.aiDraftPath), true);
  assert.strictEqual(fs.existsSync(runPaths.workingDraftPath), true);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous canonical\n");
  assert.strictEqual(runFailed.status, "validation_failed");
  assert.strictEqual(runFailed.errorCode, "OPEN_ISSUE_CHECK_INTERRUPTED");
  assert.strictEqual(globalFailed.errorCode, "OPEN_ISSUE_CHECK_INTERRUPTED");

  shouldThrow = false;
  fixture.config.env.runId = globalFailed.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const recovered = await runRevalidate(fixture.config, fixture.meetingDate);

  assert.strictEqual(recovered.validation.status, "PASS");
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
});

test("promotion failure after validation publication recovers from the same working draft", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 완료 항목\n` });
  fs.writeFileSync(fixture.reportPath, "previous canonical\n", "utf8");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, `${HEADER}\n- 완료 항목\n`);
  let createdLockPath = null;
  Object.defineProperty(fixture.config.env, "sectionHeader", {
    configurable: true,
    get() {
      if (!createdLockPath && fs.existsSync(fixture.generationStatePath)) {
        const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
        if (state.runDir) {
          const workingPath = path.join(state.runDir, "draft.working.annotated.md");
          if (fs.existsSync(workingPath)) {
            createdLockPath = `${fixture.generationStatePath}.lock`;
            fs.writeFileSync(createdLockPath, "held", "utf8");
          }
        }
      }
      return HEADER;
    },
  });

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "GENERATION_STATE_LOCKED"
  );

  const globalFailed = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const runPaths = buildRunPaths(fixture.config.env.outputDir, "2026-08-26", globalFailed.attemptId);
  const runFailed = JSON.parse(fs.readFileSync(runPaths.statePath, "utf8"));
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(runPaths.aiDraftPath), true);
  assert.strictEqual(fs.existsSync(runPaths.workingDraftPath), true);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous canonical\n");
  assert.strictEqual(runFailed.status, "validation_failed");
  assert.strictEqual(runFailed.errorCode, "GENERATION_STATE_LOCKED");
  assert.strictEqual(runFailed.validationRevision, 1);

  fs.rmSync(createdLockPath, { force: true });
  Object.defineProperty(fixture.config.env, "sectionHeader", {
    configurable: true,
    value: HEADER,
  });
  fixture.config.env.runId = globalFailed.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const recovered = await runRevalidate(fixture.config, fixture.meetingDate);

  assert.strictEqual(recovered.validation.status, "PASS");
  assert.strictEqual(recovered.validation.revision, 2);
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), `${HEADER}\n- 완료 항목\n`);
});
