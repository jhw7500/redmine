const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { runRevalidate } = require("../../index");
const { sealSnapshot, sha256, writeJsonAtomic } = require("../report-artifact");
const {
  makeSpawnMarker,
  setupFailedV2Run,
  setupSnapshot,
} = require("./helpers/report-run-fixture");

const HEADER = '#### <span style="color:blue">조현우</span>';

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
