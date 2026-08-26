const { test } = require("node:test");
const assert = require("node:assert");
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

test("run paths reject invalid dates and IDs before they can escape the date root", (t) => {
  const dir = makeRunDir(t);
  assert.throws(() => buildRunPaths(dir, "2026/08/26", ATTEMPT_ID), /YYYY-MM-DD/);
  assert.throws(() => buildRunPaths(dir, "2026-08-26", "../../escape"), /UUID/);
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
  fs.writeFileSync(`${generationStatePath}.lock`, "competitor", "utf8");

  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent: "clean\n",
    validation: { schemaVersion: 2, status: "PASS", cleanReportHash: sha256("clean\n") },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  }), /locked|promotion/i);
  assert.strictEqual(fs.existsSync(reportPath), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "running");
});

test("promotion writes matching clean and canonical content before marking the run complete", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });

  const state = promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: { schemaVersion: 2, status: "PASS", cleanReportHash: sha256(cleanContent) },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  });

  assert.strictEqual(state.status, "complete");
  assert.strictEqual(fs.readFileSync(paths.cleanReportPath, "utf8"), cleanContent);
  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), cleanContent);
  assert.strictEqual(JSON.parse(fs.readFileSync(generationStatePath, "utf8")).status, "complete");
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

test("promotion accepts an allowlisted warning regardless of a stale caller flag", (t) => {
  const dir = makeRunDir(t);
  const paths = initializeRunningRun(dir);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  const cleanContent = "clean\n";
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });

  const state = promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent,
    validation: {
      schemaVersion: 2,
      status: "WARNING",
      publishable: false,
      issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }],
      cleanReportHash: sha256(cleanContent),
    },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  });

  assert.strictEqual(state.status, "complete");
  assert.strictEqual(fs.readFileSync(reportPath, "utf8"), cleanContent);
});
