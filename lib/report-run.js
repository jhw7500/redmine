const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  hashObject,
  sha256,
  writeJsonAtomic,
  writeTextAtomic,
} = require("./report-artifact");
const { isPublishable } = require("./report-publishability");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TRANSITIONS = {
  running: new Set(["ai_failed", "ai_complete"]),
  ai_complete: new Set(["validation_failed", "complete"]),
  validation_failed: new Set(["validation_failed", "complete"]),
};

function makeRunPaths(runDir) {
  return {
    runDir,
    statePath: path.join(runDir, "state.json"),
    catalogPath: path.join(runDir, "fact-catalog.json"),
    promptInputPath: path.join(runDir, "prompt-input.json"),
    aiDraftPath: path.join(runDir, "draft.ai.annotated.md"),
    workingDraftPath: path.join(runDir, "draft.working.annotated.md"),
    cleanReportPath: path.join(runDir, "report.clean.md"),
  };
}

function buildRunPaths(outputDir, meetingDate, attemptId) {
  if (!DATE_RE.test(meetingDate)) throw new Error("meeting date must be YYYY-MM-DD");
  if (!UUID_RE.test(attemptId)) throw new Error("RUN_ID must be a UUID");
  const runRoot = path.resolve(outputDir, "runs", meetingDate);
  const runDir = path.resolve(runRoot, attemptId);
  if (path.dirname(runDir) !== runRoot) throw new Error("run path escapes root");
  return makeRunPaths(runDir);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${filePath}`);
  }
}

function assertAttemptOwned(state, expectedAttemptId) {
  if (!state || state.attemptId !== expectedAttemptId) {
    throw new Error("run state attempt ownership mismatch");
  }
}

function assertTransition(currentStatus, nextStatus, requested = true) {
  if (!requested) return;
  if (!TRANSITIONS[currentStatus] || !TRANSITIONS[currentStatus].has(nextStatus)) {
    throw new Error(`invalid run state transition: ${currentStatus} -> ${nextStatus}`);
  }
}

function initializeReportRun(paths, state) {
  if (!state || !state.attemptId || !state.status) {
    throw new Error("initial run state requires attemptId and status");
  }
  if (state.status !== "running") {
    throw new Error("a new run must start in the running state");
  }
  if (fs.existsSync(paths.statePath)) {
    throw new Error(`immutable run state already exists: ${paths.statePath}`);
  }
  fs.mkdirSync(paths.runDir, { recursive: true });
  const initialState = {
    ...state,
    validationRevision: Number.isInteger(state.validationRevision) ? state.validationRevision : 0,
  };
  writeJsonAtomic(paths.statePath, initialState);
  return initialState;
}

function writeImmutableArtifact(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(descriptor, content, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporary, filePath);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw new Error(`immutable artifact already exists: ${filePath}`);
      }
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function updateRunState(paths, expectedAttemptId, patch) {
  const current = readJson(paths.statePath, "run state");
  assertAttemptOwned(current, expectedAttemptId);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "attemptId") && patch.attemptId !== expectedAttemptId) {
    throw new Error("run state attempt ownership mismatch");
  }
  const statusRequested = patch && Object.prototype.hasOwnProperty.call(patch, "status");
  const nextStatus = statusRequested ? patch.status : current.status;
  assertTransition(current.status, nextStatus, statusRequested);
  const next = { ...current, ...patch, attemptId: current.attemptId, status: nextStatus };
  writeJsonAtomic(paths.statePath, next);
  return next;
}

function appendValidationRevision(paths, expectedAttemptId, validation) {
  const state = readJson(paths.statePath, "run state");
  assertAttemptOwned(state, expectedAttemptId);
  const previousRevision = state.validationRevision === undefined ? 0 : state.validationRevision;
  if (!Number.isInteger(previousRevision) || previousRevision < 0) {
    throw new Error("run state validation revision is invalid");
  }
  const revision = previousRevision + 1;
  const filename = `validation.${String(revision).padStart(3, "0")}.json`;
  const validationPath = path.join(paths.runDir, filename);
  const storedValidation = { ...validation, revision };
  const serialized = JSON.stringify(storedValidation, null, 2) + "\n";
  const validationHash = sha256(serialized);
  writeImmutableArtifact(validationPath, serialized);
  const next = updateRunState(paths, expectedAttemptId, {
    validationRevision: revision,
    latestValidationPath: filename,
    latestValidationHash: validationHash,
  });
  return {
    revision,
    validation: storedValidation,
    validationHash,
    validationPath,
    state: next,
  };
}

function loadReportRun(outputDir, meetingDate, attemptId) {
  const requested = buildRunPaths(outputDir, meetingDate, attemptId);
  let realRoot;
  let realRunDir;
  try {
    realRoot = fs.realpathSync(path.resolve(outputDir, "runs", meetingDate));
    realRunDir = fs.realpathSync(requested.runDir);
  } catch (error) {
    throw new Error(`run root or run directory is missing: ${requested.runDir}`);
  }
  if (path.dirname(realRunDir) !== realRoot) {
    throw new Error("run path escapes the real meeting-date root");
  }
  const paths = makeRunPaths(realRunDir);
  const state = readJson(paths.statePath, "run state");
  assertAttemptOwned(state, attemptId);
  const catalog = readJson(paths.catalogPath, "fact catalog");
  return { paths, state, catalog };
}

function assertRunInputs(state, snapshot, catalog, expected) {
  if (!state || state.schemaVersion !== 2) throw new Error("run state schema v2 is required");
  if (!expected || state.attemptId !== expected.attemptId) throw new Error("run attempt ownership mismatch");
  if (state.meetingDate !== expected.meetingDate) throw new Error("run meeting date mismatch");
  if (Number(state.reportDepth) !== Number(expected.reportDepth)) throw new Error("run report depth mismatch");
  if (!snapshot || state.snapshotHash !== snapshot.contentHash) throw new Error("run snapshot hash mismatch");
  if (!catalog || catalog.catalogHash !== state.catalogHash) throw new Error("run catalog hash mismatch");
  const computedCatalogHash = hashObject({ schemaVersion: catalog.schemaVersion, facts: catalog.facts });
  if (computedCatalogHash !== catalog.catalogHash) throw new Error("fact catalog hash mismatch");
}

function supersededError(message) {
  const error = new Error(`generation superseded: ${message}`);
  error.code = "GENERATION_SUPERSEDED";
  return error;
}

function assertGenerationStateOwned(generationStatePath, attemptId) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(generationStatePath, "utf8"));
  } catch (error) {
    throw supersededError("global generation state is missing or unreadable");
  }
  if (state.attemptId !== attemptId) {
    throw supersededError("global generation state belongs to another attempt");
  }
  return state;
}

function generationStateLockError(generationStatePath) {
  const error = new Error(`generation state is locked: ${generationStatePath}`);
  error.code = "GENERATION_STATE_LOCKED";
  return error;
}

function acquireGenerationStateLock(generationStatePath) {
  const lockPath = `${generationStatePath}.lock`;
  let descriptor;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    descriptor = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw generationStateLockError(generationStatePath);
    }
    throw error;
  }
  return () => {
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  };
}

function withGenerationStateLock(generationStatePath, operation) {
  const release = acquireGenerationStateLock(generationStatePath);
  try {
    return operation();
  } finally {
    release();
  }
}

function promoteRunReport({
  paths,
  reportPath,
  generationStatePath,
  cleanContent,
  validation,
  generationState,
}) {
  const attemptId = generationState && generationState.attemptId;
  if (
    !validation ||
    validation.schemaVersion !== 2 ||
    !isPublishable(validation) ||
    !validation.cleanReportHash ||
    validation.cleanReportHash !== sha256(cleanContent)
  ) {
    throw new Error("publishable schema v2 validation required");
  }

  const current = readJson(paths.statePath, "run state");
  assertAttemptOwned(current, attemptId);
  assertTransition(current.status, "complete");

  writeTextAtomic(paths.cleanReportPath, cleanContent);
  return withGenerationStateLock(generationStatePath, () => {
    assertGenerationStateOwned(generationStatePath, attemptId);
    writeTextAtomic(reportPath, cleanContent);
    assertGenerationStateOwned(generationStatePath, attemptId);
    writeJsonAtomic(generationStatePath, generationState);
    return updateRunState(paths, attemptId, {
      status: "complete",
      completedAt: new Date().toISOString(),
    });
  });
}

module.exports = {
  appendValidationRevision,
  assertGenerationStateOwned,
  assertRunInputs,
  buildRunPaths,
  initializeReportRun,
  loadReportRun,
  promoteRunReport,
  updateRunState,
  withGenerationStateLock,
  writeImmutableArtifact,
};
