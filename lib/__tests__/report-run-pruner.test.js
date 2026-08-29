const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pruneRunArtifacts } = require("../report-run-pruner");
const { holdFileLock } = require("./helpers/report-run-fixture");

const NOW = new Date("2026-08-29T00:00:00.000Z");
const OLD_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

function makeOutputDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-run-pruner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRun(outputDir, {
  attemptId,
  date = "2026-05-01",
  startedAt,
  status = "complete",
}) {
  const runDir = path.join(outputDir, "runs", date, attemptId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    schemaVersion: 2,
    attemptId,
    meetingDate: date,
    startedAt,
    status,
  }, null, 2) + "\n");
  return runDir;
}

test("dry-run reports an expired complete run without deleting it", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: true,
    now: NOW,
  });

  assert.deepStrictEqual(summary, {
    examined: 1,
    eligible: 1,
    deleted: 0,
    skipped: 0,
    errors: 0,
    skippedReasons: {},
  });
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("apply removes an expired complete run", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.deepStrictEqual(summary, {
    examined: 1,
    eligible: 1,
    deleted: 1,
    skipped: 0,
    errors: 0,
    skippedReasons: {},
  });
  assert.strictEqual(fs.existsSync(runDir), false);
});

test("a complete run inside the retention window is retained", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: NEW_ATTEMPT_ID,
    date: "2026-08-01",
    startedAt: "2026-08-01T00:00:00.000Z",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.deepStrictEqual(summary, {
    examined: 1,
    eligible: 0,
    deleted: 0,
    skipped: 1,
    errors: 0,
    skippedReasons: { within_retention: 1 },
  });
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("a missing runs root is an empty successful prune", (t) => {
  const outputDir = makeOutputDir(t);

  assert.deepStrictEqual(pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  }), {
    examined: 0,
    eligible: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    skippedReasons: {},
  });
});

test("an expired validation failure is removed after its recovery window", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
    status: "validation_failed",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.deleted, 1);
  assert.strictEqual(fs.existsSync(runDir), false);
});

test("active and unknown states are retained with distinct reasons", (t) => {
  const outputDir = makeOutputDir(t);
  const running = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
    status: "running",
  });
  const unknown = writeRun(outputDir, {
    attemptId: NEW_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
    status: "future_state",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.deepStrictEqual(summary.skippedReasons, {
    active_state: 1,
    invalid_status: 1,
  });
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(running), true);
  assert.strictEqual(fs.existsSync(unknown), true);
});

test("malformed state and an owner mismatch fail closed", (t) => {
  const outputDir = makeOutputDir(t);
  const malformed = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(malformed, "state.json"), "not json", "utf8");
  const mismatched = writeRun(outputDir, {
    attemptId: NEW_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const mismatchStatePath = path.join(mismatched, "state.json");
  const mismatchState = JSON.parse(fs.readFileSync(mismatchStatePath, "utf8"));
  fs.writeFileSync(mismatchStatePath, JSON.stringify({
    ...mismatchState,
    attemptId: OLD_ATTEMPT_ID,
  }));

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.deepStrictEqual(summary.skippedReasons, {
    invalid_state: 1,
    owner_mismatch: 1,
  });
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(malformed), true);
  assert.strictEqual(fs.existsSync(mismatched), true);
});

test("a FIFO state file is rejected without blocking pruning", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const statePath = path.join(runDir, "state.json");
  fs.rmSync(statePath);
  assert.strictEqual(spawnSync("mkfifo", [statePath]).status, 0);

  const prunerPath = require.resolve("../report-run-pruner");
  const child = spawnSync(process.execPath, [
    "-e",
    `const { pruneRunArtifacts } = require(${JSON.stringify(prunerPath)});
const summary = pruneRunArtifacts({
  outputDir: ${JSON.stringify(outputDir)},
  retentionDays: 90,
  dryRun: false,
  now: new Date(${JSON.stringify(NOW.toISOString())}),
});
process.stdout.write(JSON.stringify(summary));`,
  ], {
    encoding: "utf8",
    timeout: 1_000,
  });

  assert.strictEqual(child.error, undefined, child.error && child.error.message);
  assert.strictEqual(child.status, 0, child.stderr);
  const summary = JSON.parse(child.stdout);
  assert.strictEqual(summary.skippedReasons.invalid_state, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("a symbolic-link state file is rejected without reading its target", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const statePath = path.join(runDir, "state.json");
  const outsideState = path.join(outputDir, "outside-state.json");
  fs.renameSync(statePath, outsideState);
  fs.symlinkSync(outsideState, statePath);

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.invalid_state, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
  assert.strictEqual(fs.existsSync(outsideState), true);
});

test("a run with a non-v2 state schema is never deleted", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const statePath = path.join(runDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, schemaVersion: 1 }));

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.invalid_schema, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("a run whose meeting date disagrees with its directory is never deleted", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const statePath = path.join(runDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, meetingDate: "2026-05-02" }));

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.meeting_date_mismatch, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("invalid dates, IDs, and timestamps are never deleted", (t) => {
  const outputDir = makeOutputDir(t);
  const invalidDate = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    date: "not-a-date",
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const invalidId = writeRun(outputDir, {
    attemptId: "not-a-uuid",
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const invalidTimestamp = writeRun(outputDir, {
    attemptId: NEW_ATTEMPT_ID,
    startedAt: "not-a-time",
  });

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.deepStrictEqual(summary.skippedReasons, {
    invalid_date: 1,
    invalid_run_id: 1,
    invalid_started_at: 1,
  });
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(invalidDate), true);
  assert.strictEqual(fs.existsSync(invalidId), true);
  assert.strictEqual(fs.existsSync(invalidTimestamp), true);
});

test("a symbolic-link run is skipped without touching its target", (t) => {
  const outputDir = makeOutputDir(t);
  const outside = path.join(outputDir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel"), "keep", "utf8");
  const dateDir = path.join(outputDir, "runs", "2026-05-01");
  fs.mkdirSync(dateDir, { recursive: true });
  const link = path.join(dateDir, OLD_ATTEMPT_ID);
  fs.symlinkSync(outside, link, "dir");

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.symlink, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(link), true);
  assert.strictEqual(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "keep");
});

test("a symbolic-link runs root fails closed without traversing outside output", (t) => {
  const outputDir = makeOutputDir(t);
  const outside = path.join(outputDir, "outside-runs");
  const runDir = writeRun(outside, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  fs.symlinkSync(path.join(outside, "runs"), path.join(outputDir, "runs"), "dir");

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
});

test("a date directory replacement cannot redirect recursive deletion", (t) => {
  const outputDir = makeOutputDir(t);
  const insideRun = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const outsideRoot = path.join(outputDir, "outside-root");
  const outsideRun = writeRun(outsideRoot, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const dateDir = path.dirname(insideRun);
  const savedDateDir = `${dateDir}.saved`;
  const outsideDateDir = path.dirname(outsideRun);
  const originalRmSync = fs.rmSync;
  let swapped = false;
  fs.rmSync = (target, options) => {
    const targetName = path.basename(target);
    if (!swapped && (
      target === insideRun
      || targetName.startsWith(`.prune-${OLD_ATTEMPT_ID}-`)
    )) {
      fs.renameSync(dateDir, savedDateDir);
      fs.symlinkSync(outsideDateDir, dateDir, "dir");
      swapped = true;
    }
    return originalRmSync(target, options);
  };

  let summary;
  try {
    summary = pruneRunArtifacts({
      outputDir,
      retentionDays: 90,
      dryRun: false,
      now: NOW,
    });
  } finally {
    fs.rmSync = originalRmSync;
    if (fs.lstatSync(dateDir).isSymbolicLink()) fs.rmSync(dateDir);
    if (fs.existsSync(savedDateDir)) fs.renameSync(savedDateDir, dateDir);
  }

  assert.strictEqual(swapped, true);
  assert.strictEqual(summary.deleted, 1);
  assert.strictEqual(fs.existsSync(insideRun), false);
  assert.strictEqual(fs.existsSync(outsideRun), true);
});

test("a held validation lock protects an expired terminal run", async (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const held = holdFileLock(t, path.join(runDir, ".validation.lock"));

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.locked, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
  await held.release();
});

test("apply rejects a symlinked validation lock without touching its target", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const outsideLock = path.join(outputDir, "outside-validation.lock");
  fs.writeFileSync(outsideLock, "outside", "utf8");
  fs.symlinkSync(outsideLock, path.join(runDir, ".validation.lock"));

  const summary = pruneRunArtifacts({
    outputDir,
    retentionDays: 90,
    dryRun: false,
    now: NOW,
  });

  assert.strictEqual(summary.skippedReasons.invalid_lock, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(fs.existsSync(runDir), true);
  assert.strictEqual(fs.readFileSync(outsideLock, "utf8"), "outside");
});

test("apply holds the validation lock through recursive deletion", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(runDir, ".validation.lock"), "", "utf8");
  const originalRmSync = fs.rmSync;
  let contenderStatus = null;
  fs.rmSync = (target, options) => {
    const targetName = path.basename(target);
    if (
      target === runDir
      || targetName.startsWith(`.prune-${OLD_ATTEMPT_ID}-`)
    ) {
      const contenderLockPath = path.join(
        fs.realpathSync(target),
        ".validation.lock"
      );
      contenderStatus = spawnSync("flock", [
        "-n",
        "-E",
        "75",
        contenderLockPath,
        "true",
      ], { stdio: "ignore" }).status;
    }
    return originalRmSync(target, options);
  };

  let summary;
  try {
    summary = pruneRunArtifacts({
      outputDir,
      retentionDays: 90,
      dryRun: false,
      now: NOW,
    });
  } finally {
    fs.rmSync = originalRmSync;
  }

  assert.strictEqual(contenderStatus, 75);
  assert.strictEqual(summary.deleted, 1);
  assert.strictEqual(fs.existsSync(runDir), false);
});

test("a deletion failure is counted and leaves the run in place", (t) => {
  const outputDir = makeOutputDir(t);
  const runDir = writeRun(outputDir, {
    attemptId: OLD_ATTEMPT_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
  });
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (
      target === runDir
      || path.basename(target).startsWith(`.prune-${OLD_ATTEMPT_ID}-`)
    ) {
      throw new Error("simulated deletion failure");
    }
    return originalRmSync(target, options);
  };

  let summary;
  try {
    summary = pruneRunArtifacts({
      outputDir,
      retentionDays: 90,
      dryRun: false,
      now: NOW,
    });
  } finally {
    fs.rmSync = originalRmSync;
  }

  assert.strictEqual(summary.eligible, 1);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(fs.existsSync(runDir), true);
});
