const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const {
  hashObject,
  sha256,
  writeJsonAtomic,
  writeTextAtomic,
} = require("./report-artifact");
const { isPublishable } = require("./report-publishability");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const activeRunValidationLocks = new Set();
const UNKNOWN_LOCK_GRACE_MS = 5 * 60 * 1000;

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
  return withRunValidationLock(paths, () => {
    const state = readJson(paths.statePath, "run state");
    assertAttemptOwned(state, expectedAttemptId);
    if (!["ai_complete", "validation_failed"].includes(state.status)) {
      throw new Error(
        `validation revision requires ai_complete or validation_failed state, got ${state.status}`
      );
    }
    const previousRevision = state.validationRevision === undefined ? 0 : state.validationRevision;
    if (!Number.isInteger(previousRevision) || previousRevision < 0) {
      throw new Error("run state validation revision is invalid");
    }
    let revision = previousRevision + 1;
    while (fs.existsSync(path.join(
      paths.runDir,
      `validation.${String(revision).padStart(3, "0")}.json`
    ))) {
      revision += 1;
    }
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
  });
}

function resolveReportRunPaths(outputDir, meetingDate, attemptId) {
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
  return makeRunPaths(realRunDir);
}

function loadResolvedReportRun(paths, attemptId) {
  const state = readJson(paths.statePath, "run state");
  assertAttemptOwned(state, attemptId);
  const catalog = readJson(paths.catalogPath, "fact catalog");
  return { paths, state, catalog };
}

function loadReportRun(outputDir, meetingDate, attemptId) {
  return loadResolvedReportRun(
    resolveReportRunPaths(outputDir, meetingDate, attemptId),
    attemptId
  );
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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function localLockOwnerAlive(record) {
  if (
    !record
    || record.schemaVersion !== 1
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || typeof record.hostname !== "string"
  ) return null;
  if (record.hostname !== os.hostname()) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

function reclaimStaleLock(lockPath) {
  let before;
  let record = null;
  try {
    before = fs.statSync(lockPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
    return false;
  }
  try {
    record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
  }

  const alive = localLockOwnerAlive(record);
  if (alive === true) return false;
  if (alive === null && Date.now() - before.mtimeMs < UNKNOWN_LOCK_GRACE_MS) return false;

  let after;
  try {
    after = fs.statSync(lockPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return true;
    return false;
  }
  if (!sameFile(before, after)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
}

function releaseOwnedFileLock(descriptor, lockPath) {
  let ownedFile = null;
  try {
    ownedFile = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    const current = fs.statSync(lockPath);
    if (ownedFile && sameFile(ownedFile, current)) fs.unlinkSync(lockPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function acquireFileLock(lockPath, lockError) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }) + "\n");
      fs.fsyncSync(descriptor);
      return () => releaseOwnedFileLock(descriptor, lockPath);
    } catch (error) {
      if (descriptor !== undefined) {
        try { releaseOwnedFileLock(descriptor, lockPath); } catch (_) { /* preserve root cause */ }
      }
      if (!error || error.code !== "EEXIST" || !reclaimStaleLock(lockPath)) {
        if (error && error.code === "EEXIST") throw lockError();
        throw error;
      }
    }
  }
  throw lockError();
}

function acquireGenerationStateLock(generationStatePath) {
  const lockPath = `${generationStatePath}.lock`;
  return acquireFileLock(lockPath, () => generationStateLockError(generationStatePath));
}

function withGenerationStateLock(generationStatePath, operation) {
  const release = acquireGenerationStateLock(generationStatePath);
  try {
    return operation();
  } finally {
    release();
  }
}

function runValidationLockError(paths) {
  const error = new Error(`run validation is locked: ${paths.runDir}`);
  error.code = "RUN_VALIDATION_LOCKED";
  return error;
}

function withRunValidationLock(paths, operation) {
  const lockPath = path.join(paths.runDir, ".validation.lock");
  if (activeRunValidationLocks.has(lockPath)) return operation();

  const release = acquireFileLock(lockPath, () => runValidationLockError(paths));

  activeRunValidationLocks.add(lockPath);
  try {
    return operation();
  } finally {
    activeRunValidationLocks.delete(lockPath);
    release();
  }
}

function staleValidationError(message) {
  const error = new Error(`stale validation revision: ${message}`);
  error.code = "STALE_VALIDATION_REVISION";
  return error;
}

function assertLatestValidationOwned(paths, state, attemptId, validation, generationState) {
  const revision = validation && validation.revision;
  if (!Number.isInteger(revision) || revision < 1 || validation.attemptId !== attemptId) {
    throw staleValidationError("owned revision evidence is missing");
  }
  const filename = `validation.${String(revision).padStart(3, "0")}.json`;
  const serialized = JSON.stringify(validation, null, 2) + "\n";
  const validationHash = sha256(serialized);
  if (
    state.validationRevision !== revision
    || state.latestValidationPath !== filename
    || state.latestValidationHash !== validationHash
    || generationState.validationRevision !== revision
    || generationState.latestValidationPath !== filename
    || generationState.latestValidationHash !== validationHash
  ) {
    throw staleValidationError("exact latest revision, path, and hash are required");
  }

  const validationPath = path.join(paths.runDir, filename);
  let storedValidation;
  try {
    storedValidation = fs.readFileSync(validationPath, "utf8");
  } catch (error) {
    throw staleValidationError("latest immutable artifact is missing or unreadable");
  }
  if (sha256(storedValidation) !== validationHash) {
    throw staleValidationError("latest immutable artifact hash differs");
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
  return withRunValidationLock(paths, () => {
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

    // Lock order is always run validation -> generation state.
    return withGenerationStateLock(generationStatePath, () => {
      assertGenerationStateOwned(generationStatePath, attemptId);
      assertLatestValidationOwned(paths, current, attemptId, validation, generationState);
      const cleanExisted = fs.existsSync(paths.cleanReportPath);
      const previousClean = cleanExisted ? fs.readFileSync(paths.cleanReportPath) : null;
      const canonicalExisted = fs.existsSync(reportPath);
      const previousCanonical = canonicalExisted ? fs.readFileSync(reportPath) : null;
      const previousGenerationState = fs.readFileSync(generationStatePath);
      const previousRunState = fs.readFileSync(paths.statePath);
      let generationStateWritten = false;
      let runStateWriteAttempted = false;
      try {
        writeTextAtomic(paths.cleanReportPath, cleanContent);
        writeTextAtomic(reportPath, cleanContent);
        assertGenerationStateOwned(generationStatePath, attemptId);
        writeJsonAtomic(generationStatePath, generationState);
        generationStateWritten = true;
        runStateWriteAttempted = true;
        return updateRunState(paths, attemptId, {
          status: "complete",
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        const rollbackErrors = [];
        const restorations = [
          () => cleanExisted
            ? writeTextAtomic(paths.cleanReportPath, previousClean)
            : fs.rmSync(paths.cleanReportPath, { force: true }),
          () => canonicalExisted
            ? writeTextAtomic(reportPath, previousCanonical)
            : fs.rmSync(reportPath, { force: true }),
        ];
        if (generationStateWritten) {
          restorations.push(() => writeTextAtomic(generationStatePath, previousGenerationState));
        }
        if (runStateWriteAttempted) {
          restorations.push(() => writeTextAtomic(paths.statePath, previousRunState));
        }
        for (const restore of restorations) {
          try {
            restore();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) error.rollbackErrors = rollbackErrors;
        throw error;
      }
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
  loadResolvedReportRun,
  promoteRunReport,
  resolveReportRunPaths,
  updateRunState,
  withGenerationStateLock,
  withRunValidationLock,
  writeImmutableArtifact,
};
