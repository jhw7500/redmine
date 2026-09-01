const { test } = require("node:test");
const assert = require("node:assert");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendValidationRevision,
  assertGenerationStateOwned,
  assertRunInputs,
  buildRunPaths,
  initializeReportRun,
  loadReportRun,
  promoteRunReport,
  updateRunState,
  withGenerationStateLock,
  withRunValidationLock,
  writeImmutableArtifact,
} = require("../report-run");
const { hashObject, sha256, writeJsonAtomic } = require("../report-artifact");

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

function makeRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-report-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeCatalog() {
  const facts = [{ id: "Q0001", raw: "16건" }];
  return {
    schemaVersion: 1,
    facts,
    catalogHash: hashObject({ schemaVersion: 1, facts }),
  };
}

function makeCoverageCatalog() {
  const sections = [{ id: "C0001", requiredPath: ["PIM", "Platform"] }];
  const items = [{ id: "N0001", requiredPath: ["PIM", "Platform"] }];
  const knownPaths = [["PIM", "Platform"]];
  return {
    schemaVersion: 1,
    sections,
    items,
    knownPaths,
    coverageCatalogHash: hashObject({ schemaVersion: 1, sections, items, knownPaths }),
  };
}

function initializeRunningRun(dir, attemptId = ATTEMPT_ID, extra = {}) {
  const paths = buildRunPaths(dir, "2026-08-26", attemptId);
  initializeReportRun(paths, {
    schemaVersion: 2,
    attemptId,
    status: "running",
    meetingDate: "2026-08-26",
    reportDepth: 3,
    snapshotHash: "snapshot-hash",
    catalogHash: makeCatalog().catalogHash,
    ...extra,
  });
  return paths;
}

function publishValidation(paths, cleanContent, patch = {}) {
  return appendValidationRevision(paths, ATTEMPT_ID, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "PASS",
    cleanReportHash: sha256(cleanContent),
    ...patch,
  });
}

function completedGenerationState(revision, patch = {}) {
  return {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "complete",
    validationRevision: revision.revision,
    latestValidationPath: path.basename(revision.validationPath),
    latestValidationHash: revision.validationHash,
    ...patch,
  };
}

test("run storage prevents overwriting the immutable AI draft and preserves every validation revision", (t) => {
  const paths = initializeRunningRun(makeRunDir(t));
  writeImmutableArtifact(paths.aiDraftPath, "raw stdout");
  assert.throws(() => writeImmutableArtifact(paths.aiDraftPath, "overwrite"), /immutable/);

  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  const first = appendValidationRevision(paths, ATTEMPT_ID, { schemaVersion: 2, status: "FAIL" });
  updateRunState(paths, ATTEMPT_ID, { status: "validation_failed" });
  const second = appendValidationRevision(paths, ATTEMPT_ID, { schemaVersion: 2, status: "PASS" });

  assert.strictEqual(path.basename(first.validationPath), "validation.001.json");
  assert.strictEqual(path.basename(second.validationPath), "validation.002.json");
  assert.strictEqual(first.validation.revision, 1);
  assert.strictEqual(second.validation.revision, 2);
  assert.strictEqual(first.validationHash, sha256(fs.readFileSync(first.validationPath, "utf8")));
  assert.strictEqual(second.validationHash, sha256(fs.readFileSync(second.validationPath, "utf8")));
  const state = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  assert.strictEqual(state.latestValidationPath, "validation.002.json");
  assert.strictEqual(state.latestValidationHash, second.validationHash);
});

test("validation publication skips an orphaned immutable revision and advances ownership", (t) => {
  const paths = initializeRunningRun(makeRunDir(t));
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeImmutableArtifact(
    path.join(paths.runDir, "validation.001.json"),
    JSON.stringify({ schemaVersion: 2, status: "FAIL", revision: 1 }, null, 2) + "\n"
  );

  const published = appendValidationRevision(paths, ATTEMPT_ID, {
    schemaVersion: 2,
    status: "PASS",
  });

  assert.strictEqual(path.basename(published.validationPath), "validation.002.json");
  assert.strictEqual(published.validation.revision, 2);
  const state = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  assert.strictEqual(state.validationRevision, 2);
  assert.strictEqual(state.latestValidationPath, "validation.002.json");
});

test("validation publication rejects a completed run without creating a revision", (t) => {
  const paths = initializeRunningRun(makeRunDir(t));
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  const first = appendValidationRevision(paths, ATTEMPT_ID, {
    schemaVersion: 2,
    status: "PASS",
  });
  updateRunState(paths, ATTEMPT_ID, { status: "complete" });
  const completedState = fs.readFileSync(paths.statePath, "utf8");

  assert.throws(
    () => appendValidationRevision(paths, ATTEMPT_ID, { schemaVersion: 2, status: "PASS" }),
    /validation.*state|state.*validation/i
  );
  assert.strictEqual(fs.existsSync(path.join(paths.runDir, "validation.002.json")), false);
  assert.strictEqual(fs.readFileSync(paths.statePath, "utf8"), completedState);
  assert.strictEqual(first.revision, 1);
});

test("immutable artifact publication rejects a competitor that creates the destination after its preflight", (t) => {
  const filePath = path.join(makeRunDir(t), "draft.ai.annotated.md");
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (temporary, destination) => {
    assert.strictEqual(destination, filePath);
    fs.writeFileSync(filePath, "competitor", "utf8");
    return originalLinkSync(temporary, destination);
  };
  try {
    assert.throws(() => writeImmutableArtifact(filePath, "ours"), /immutable/);
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.strictEqual(fs.readFileSync(filePath, "utf8"), "competitor");
});

test("a stale same-attempt validation revision cannot promote after a competitor publishes newer evidence", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const previousCanonical = "previous canonical\n";
  const previousClean = "previous clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  fs.writeFileSync(reportPath, previousCanonical, "utf8");
  fs.writeFileSync(paths.cleanReportPath, previousClean, "utf8");
  writeJsonAtomic(generationStatePath, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "running",
  });

  const older = appendValidationRevision(paths, ATTEMPT_ID, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "PASS",
    cleanReportHash: sha256("older clean\n"),
  });
  const newer = appendValidationRevision(paths, ATTEMPT_ID, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "PASS",
    cleanReportHash: sha256("newer clean\n"),
  });
  const newerRunState = fs.readFileSync(paths.statePath, "utf8");
  const previousGenerationState = fs.readFileSync(generationStatePath, "utf8");

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent: "older clean\n",
    validation: older.validation,
    generationState: {
      schemaVersion: 2,
      attemptId: ATTEMPT_ID,
      status: "complete",
      validationRevision: older.revision,
      latestValidationPath: path.basename(older.validationPath),
      latestValidationHash: older.validationHash,
    },
  }), /latest|stale|revision/i);

  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), previousCanonical);
  assert.strictEqual(fs.readFileSync(paths.cleanReportPath, "utf8"), previousClean);
  assert.strictEqual(fs.readFileSync(generationStatePath, "utf8"), previousGenerationState);
  assert.strictEqual(fs.readFileSync(paths.statePath, "utf8"), newerRunState);
  assert.strictEqual(JSON.parse(newerRunState).validationRevision, newer.revision);
  assert.strictEqual(JSON.parse(newerRunState).latestValidationHash, newer.validationHash);
});

test("run paths reject invalid dates and IDs before they can escape the date root", (t) => {
  const dir = makeRunDir(t);
  assert.throws(() => buildRunPaths(dir, "2026/08/26", ATTEMPT_ID), /YYYY-MM-DD/);
  assert.throws(() => buildRunPaths(dir, "2026-08-26", "../../escape"), /UUID/);
});

test("run paths include the immutable source coverage artifact", (t) => {
  const paths = buildRunPaths(makeRunDir(t), "2026-08-26", ATTEMPT_ID);

  assert.strictEqual(paths.coverageCatalogPath, path.join(paths.runDir, "source-coverage.json"));
});

test("run state permits only the designed state graph and matching owner", (t) => {
  const paths = initializeRunningRun(makeRunDir(t));
  assert.throws(() => updateRunState(paths, ATTEMPT_ID, { status: "complete" }), /transition/);
  assert.throws(() => updateRunState(paths, ATTEMPT_ID, { status: "running" }), /transition/);
  assert.throws(() => updateRunState(paths, OTHER_ATTEMPT_ID, { status: "ai_complete" }), /attempt/i);
  assert.strictEqual(updateRunState(paths, ATTEMPT_ID, { note: "still running" }).status, "running");
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  updateRunState(paths, ATTEMPT_ID, { status: "validation_failed" });
  assert.strictEqual(updateRunState(paths, ATTEMPT_ID, { status: "complete" }).status, "complete");
});

test("a new run can begin only in the running state", (t) => {
  const paths = buildRunPaths(makeRunDir(t), "2026-08-26", ATTEMPT_ID);
  assert.throws(() => initializeReportRun(paths, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "complete",
  }), /running/);
});

test("loading a run proves the resolved directory remains under its date root", (t) => {
  const dir = makeRunDir(t);
  const root = path.join(dir, "runs", "2026-08-26");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, ATTEMPT_ID), "dir");
  assert.throws(() => loadReportRun(dir, "2026-08-26", ATTEMPT_ID), /run root|escapes/i);
});

test("loading rejects a run whose state owner differs from its requested UUID", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  writeJsonAtomic(paths.catalogPath, makeCatalog());
  writeJsonAtomic(paths.statePath, { ...JSON.parse(fs.readFileSync(paths.statePath, "utf8")), attemptId: OTHER_ATTEMPT_ID });
  assert.throws(() => loadReportRun(dir, "2026-08-26", ATTEMPT_ID), /attempt/i);
});

test("loading a coverage-free run does not require the source coverage artifact", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  writeJsonAtomic(paths.catalogPath, makeCatalog());

  const run = loadReportRun(dir, "2026-08-26", ATTEMPT_ID);

  assert.strictEqual(run.coverageCatalog, null);
  assert.strictEqual(fs.existsSync(path.join(paths.runDir, "source-coverage.json")), false);
});

test("coverage-enabled runs require an owned exact source coverage catalog", (t) => {
  const dir = makeRunDir(t);
  const coverageCatalog = makeCoverageCatalog();
  const paths = initializeRunningRun(dir, ATTEMPT_ID, {
    sourceCoverageMode: "required_sections_notion_advisory_v2",
    coverageCatalogHash: coverageCatalog.coverageCatalogHash,
  });
  const state = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  const catalog = makeCatalog();
  const snapshot = { contentHash: "snapshot-hash" };
  const expected = {
    attemptId: ATTEMPT_ID,
    meetingDate: "2026-08-26",
    reportDepth: 3,
  };
  writeJsonAtomic(paths.catalogPath, catalog);
  writeJsonAtomic(paths.coverageCatalogPath, coverageCatalog);

  const run = loadReportRun(dir, "2026-08-26", ATTEMPT_ID);
  assert.deepStrictEqual(run.coverageCatalog, coverageCatalog);
  assert.doesNotThrow(() => assertRunInputs(state, snapshot, catalog, expected, coverageCatalog));

  const changedCoverageCatalog = {
    ...coverageCatalog,
    sections: [{ id: "C0001", requiredPath: ["PIM", "Changed"] }],
  };
  assert.throws(
    () => assertRunInputs(state, snapshot, catalog, expected, changedCoverageCatalog),
    /coverage catalog hash/i
  );
  assert.throws(
    () => assertRunInputs({ ...state, coverageCatalogHash: undefined }, snapshot, catalog, expected, coverageCatalog),
    /coverage catalog hash/i
  );

  writeJsonAtomic(paths.coverageCatalogPath, changedCoverageCatalog);
  assert.throws(() => loadReportRun(dir, "2026-08-26", ATTEMPT_ID), /coverage catalog hash/i);
  writeJsonAtomic(paths.coverageCatalogPath, null);
  assert.throws(() => loadReportRun(dir, "2026-08-26", ATTEMPT_ID), /coverage catalog hash/i);
  fs.rmSync(paths.coverageCatalogPath);
  assert.throws(() => loadReportRun(dir, "2026-08-26", ATTEMPT_ID), /coverage catalog/i);
});

test("run inputs require matching v2 owner, snapshot, catalog, date, and depth", (t) => {
  const paths = initializeRunningRun(makeRunDir(t));
  const state = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  const catalog = makeCatalog();
  const snapshot = { contentHash: "snapshot-hash" };
  assert.doesNotThrow(() => assertRunInputs(state, snapshot, catalog, {
    attemptId: ATTEMPT_ID,
    meetingDate: "2026-08-26",
    reportDepth: 3,
  }));
  assert.throws(() => assertRunInputs(state, { contentHash: "changed" }, catalog, {
    attemptId: ATTEMPT_ID,
    meetingDate: "2026-08-26",
    reportDepth: 3,
  }), /snapshot/i);
  assert.throws(() => assertRunInputs(state, snapshot, { ...catalog, catalogHash: "tampered" }, {
    attemptId: ATTEMPT_ID,
    meetingDate: "2026-08-26",
    reportDepth: 3,
  }), /catalog/i);
});

test("generation state ownership rejects a missing, malformed, or superseded global attempt", (t) => {
  const dir = makeRunDir(t);
  const statePath = path.join(dir, "report.generation.json");
  for (const write of [
    () => {},
    () => fs.writeFileSync(statePath, "not json", "utf8"),
    () => writeJsonAtomic(statePath, { attemptId: OTHER_ATTEMPT_ID, status: "running" }),
  ]) {
    fs.rmSync(statePath, { force: true });
    write();
    assert.throws(() => assertGenerationStateOwned(statePath, ATTEMPT_ID), (error) => error.code === "GENERATION_SUPERSEDED");
  }
});

test("a superseded run cannot change the canonical report", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: OTHER_ATTEMPT_ID, status: "running" });

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent: "clean\n",
    validation: { schemaVersion: 2, status: "PASS", cleanReportHash: sha256("clean\n") },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  }), /superseded/);
  assert.strictEqual(fs.existsSync(reportPath), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath, "utf8")).status, "ai_complete");
});

test("promotion fails closed while the exact generation-state lock is held", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  withGenerationStateLock(generationStatePath, () => {
    assert.throws(() => promoteRunReport({
      paths,
      reportPath,
      generationStatePath,
      cleanContent: "clean\n",
      validation: { schemaVersion: 2, status: "PASS", cleanReportHash: sha256("clean\n") },
      generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
    }), /locked|promotion/i);
  });
  assert.strictEqual(fs.existsSync(reportPath), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "running");
});

test("generation-state lock ignores legacy metadata from a terminated process", (t) => {
  const dir = makeRunDir(t);
  const generationStatePath = path.join(dir, "report.generation.json");
  const lockPath = `${generationStatePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 999999999,
    hostname: os.hostname(),
    createdAt: "2026-08-26T00:00:00.000Z",
  }));

  const result = withGenerationStateLock(generationStatePath, () => "recovered");

  assert.strictEqual(result, "recovered");
  assert.strictEqual(fs.existsSync(lockPath), true);
});

test("generation-state lock never unlinks an inode held by a live OS lock owner", async (t) => {
  const dir = makeRunDir(t);
  const generationStatePath = path.join(dir, "report.generation.json");
  const lockPath = `${generationStatePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 999999999,
    hostname: os.hostname(),
    createdAt: "2026-08-26T00:00:00.000Z",
  }));
  const originalLock = fs.statSync(lockPath);
  const holder = spawn(
    "bash",
    ["-c", 'exec 9>>"$1"; flock 9; echo locked; read -r _', "bash", lockPath],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  t.after(() => holder.kill("SIGTERM"));
  await once(holder.stdout, "data");

  let entered = false;
  assert.throws(
    () => withGenerationStateLock(generationStatePath, () => { entered = true; }),
    /locked/i
  );
  assert.strictEqual(entered, false);
  assert.strictEqual(fs.statSync(lockPath).ino, originalLock.ino);

  holder.stdin.end("release\n");
  await once(holder, "exit");
  assert.strictEqual(
    withGenerationStateLock(generationStatePath, () => "acquired-after-release"),
    "acquired-after-release"
  );
});

test("run-validation lock ignores legacy metadata from a terminated process", (t) => {
  const dir = makeRunDir(t);
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  fs.mkdirSync(paths.runDir, { recursive: true });
  const lockPath = path.join(paths.runDir, ".validation.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: 1,
    pid: 999999999,
    hostname: os.hostname(),
    createdAt: "2026-08-26T00:00:00.000Z",
  }));

  const result = withRunValidationLock(paths, () => "recovered");

  assert.strictEqual(result, "recovered");
  assert.strictEqual(fs.existsSync(lockPath), true);
});

test("file-lock wrappers reject asynchronous callbacks instead of unlocking pending work", (t) => {
  const dir = makeRunDir(t);
  const generationStatePath = path.join(dir, "report.generation.json");
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  fs.mkdirSync(paths.runDir, { recursive: true });

  assert.throws(
    () => withGenerationStateLock(generationStatePath, () => Promise.resolve("pending")),
    (error) => error.code === "ASYNC_FILE_LOCK_CALLBACK"
  );
  assert.throws(
    () => withRunValidationLock(paths, () => Promise.resolve("pending")),
    (error) => error.code === "ASYNC_FILE_LOCK_CALLBACK"
  );
  assert.strictEqual(withGenerationStateLock(generationStatePath, () => "sync"), "sync");
  assert.strictEqual(withRunValidationLock(paths, () => "sync"), "sync");
});

test("promotion writes matching clean and canonical content before marking the run complete", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  const revision = publishValidation(paths, cleanContent);

  const state = promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: revision.validation,
    generationState: completedGenerationState(revision),
  });

  assert.strictEqual(state.status, "complete");
  assert.strictEqual(fs.readFileSync(paths.cleanReportPath, "utf8"), cleanContent);
  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), cleanContent);
  assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "complete");
});

test("promotion restores the canonical report when a later state write fails", async (t) => {
  for (const previousContent of ["previous valid report\n", null]) {
    await t.test(previousContent === null ? "previously absent" : "previously present", () => {
      const dir = makeRunDir(t);
      const paths = initializeRunningRun(dir);
      const reportPath = path.join(dir, "report.md");
      const generationStatePath = path.join(dir, "report.generation.json");
      const cleanContent = "replacement report\n";
      updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
      writeJsonAtomic(generationStatePath, {
        schemaVersion: 2,
        attemptId: ATTEMPT_ID,
        status: "running",
      });
      if (previousContent !== null) fs.writeFileSync(reportPath, previousContent, "utf8");
      const revision = publishValidation(paths, cleanContent);

      const originalRenameSync = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (destination === generationStatePath) {
          assert.strictEqual(fs.readFileSync(reportPath, "utf8"), cleanContent);
          throw new Error("injected post-canonical state failure");
        }
        return originalRenameSync(source, destination);
      };
      try {
        assert.throws(() => promoteRunReport({
          paths,
          reportPath,
          generationStatePath,
          cleanContent,
          validation: revision.validation,
          generationState: completedGenerationState(revision),
        }), /injected post-canonical state failure/);
      } finally {
        fs.renameSync = originalRenameSync;
      }

      assert.strictEqual(fs.existsSync(reportPath), previousContent !== null);
      if (previousContent !== null) {
        assert.strictEqual(fs.readFileSync(reportPath, "utf8"), previousContent);
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath, "utf8")).status, "ai_complete");
      assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "running");
      assert.strictEqual(fs.existsSync(paths.cleanReportPath), false);
    });
  }
});

test("promotion does not leave completed state when the final run-state write fails", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "replacement report\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "running",
  });
  fs.writeFileSync(reportPath, "previous valid report\n", "utf8");
  const revision = publishValidation(paths, cleanContent);

  const originalRenameSync = fs.renameSync;
  let failureInjected = false;
  fs.renameSync = (source, destination) => {
    if (destination === paths.statePath && !failureInjected) {
      failureInjected = true;
      assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "complete");
      throw new Error("injected final run-state failure");
    }
    return originalRenameSync(source, destination);
  };
  try {
    assert.throws(() => promoteRunReport({
      paths,
      reportPath,
      generationStatePath,
      cleanContent,
      validation: revision.validation,
      generationState: completedGenerationState(revision),
    }), /injected final run-state failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "running");
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath, "utf8")).status, "ai_complete");
  assert.strictEqual(fs.existsSync(paths.cleanReportPath), false);
});

test("promotion rollback preserves a newer generation owner", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "replacement report\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    status: "running",
  });
  fs.writeFileSync(reportPath, "previous valid report\n", "utf8");
  const revision = publishValidation(paths, cleanContent);

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    const result = originalRenameSync(source, destination);
    if (destination === reportPath) {
      fs.writeFileSync(generationStatePath, JSON.stringify({
        schemaVersion: 2,
        attemptId: OTHER_ATTEMPT_ID,
        status: "running",
      }), "utf8");
    }
    return result;
  };
  try {
    assert.throws(() => promoteRunReport({
      paths,
      reportPath,
      generationStatePath,
      cleanContent,
      validation: revision.validation,
      generationState: completedGenerationState(revision),
    }), /superseded/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(generationStatePath, "utf8")).attemptId,
    OTHER_ATTEMPT_ID
  );
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath, "utf8")).status, "ai_complete");
});

test("promotion never trusts a publishable flag on a failed validation", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: {
      schemaVersion: 2,
      status: "FAIL",
      publishable: true,
      cleanReportHash: sha256(cleanContent),
    },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  }), /publishable schema v2 validation required/);
  assert.strictEqual(fs.existsSync(reportPath), false);
});

test("promotion rejects a fabricated publishable flag on a blocking warning", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: {
      schemaVersion: 2,
      status: "WARNING",
      publishable: true,
      issues: [{ severity: "warning", code: "open_status_resolution_evidence" }],
      cleanReportHash: sha256(cleanContent),
    },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  }), /publishable schema v2 validation required/);
  assert.strictEqual(fs.existsSync(reportPath), false);
});

test("promotion rejects an open-status warning without pickaxe evidence", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  const revision = publishValidation(paths, cleanContent, {
    status: "WARNING",
    publishable: false,
    issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }],
  });

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: revision.validation,
    generationState: completedGenerationState(revision),
  }), /publishable schema v2 validation required/);
  assert.strictEqual(fs.existsSync(reportPath), false);
});
