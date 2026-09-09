const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRANSITIONS = {
  preparing: new Set(["ready", "failed"]),
  ready: new Set(["publishing", "failed"]),
  publishing: new Set(["published", "failed"]),
};

function buildWeeklyPipelinePaths(outputDir, meetingDate) {
  if (typeof meetingDate !== "string" || !DATE_RE.test(meetingDate)) {
    throw new Error("meeting date must be YYYY-MM-DD");
  }
  const pipelineRoot = path.resolve(outputDir, "pipeline");
  const meetingDir = path.resolve(outputDir, "pipeline", meetingDate);
  if (path.dirname(meetingDir) !== pipelineRoot) {
    throw new Error("weekly meeting path escapes pipeline root");
  }
  return {
    meetingDir,
    statusPath: path.join(meetingDir, "status.json"),
    failuresDir: path.join(meetingDir, "failures"),
  };
}

function assertNotSymlink(entryPath, label) {
  let stats;
  try {
    stats = fs.lstatSync(entryPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  return stats;
}

function assertWeeklyPathOwnership(paths) {
  if (!paths || typeof paths.meetingDir !== "string") {
    throw new Error("weekly pipeline paths are required");
  }
  const meetingDir = path.resolve(paths.meetingDir);
  const pipelineRoot = path.dirname(meetingDir);
  const outputRoot = path.dirname(pipelineRoot);
  if (
    path.basename(pipelineRoot) !== "pipeline"
    || !DATE_RE.test(path.basename(meetingDir))
    || paths.statusPath !== path.join(meetingDir, "status.json")
    || paths.failuresDir !== path.join(meetingDir, "failures")
  ) {
    throw new Error("weekly pipeline path ownership mismatch");
  }

  assertNotSymlink(pipelineRoot, "weekly pipeline directory");
  assertNotSymlink(meetingDir, "weekly meeting directory");
  assertNotSymlink(paths.statusPath, "weekly status file");

  if (!fs.existsSync(meetingDir)) return;
  const realOutputRoot = fs.realpathSync(outputRoot);
  const realPipelineRoot = fs.realpathSync(pipelineRoot);
  const realMeetingDir = fs.realpathSync(meetingDir);
  if (
    path.dirname(realPipelineRoot) !== realOutputRoot
    || path.dirname(realMeetingDir) !== realPipelineRoot
  ) {
    throw new Error("weekly pipeline realpath escapes configured output directory");
  }
}

function makeWeeklyDirectories(paths) {
  const pipelineRoot = path.dirname(paths.meetingDir);
  const outputRoot = path.dirname(pipelineRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  assertNotSymlink(pipelineRoot, "weekly pipeline directory");
  if (!fs.existsSync(pipelineRoot)) fs.mkdirSync(pipelineRoot);
  assertNotSymlink(paths.meetingDir, "weekly meeting directory");
  if (!fs.existsSync(paths.meetingDir)) fs.mkdirSync(paths.meetingDir);
  assertWeeklyPathOwnership(paths);
}

function writeJsonDurableAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  let directoryDescriptor;
  let renamed = false;
  try {
    assertNotSymlink(filePath, "weekly status file");
    descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
    assertNotSymlink(filePath, "weekly status file");
    fs.renameSync(temporary, filePath);
    renamed = true;
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}

function readWeeklyStatus(paths) {
  assertWeeklyPathOwnership(paths);
  if (!fs.existsSync(paths.statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.statusPath, "utf8"));
  } catch (error) {
    throw new Error(`weekly status is unreadable: ${paths.statusPath}`);
  }
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function assertOwned(state, expectedAttemptId) {
  if (!state || state.pipelineAttemptId !== expectedAttemptId) {
    throw new Error("weekly pipeline attempt ownership mismatch");
  }
}

function assertTransition(currentStatus, nextStatus) {
  if (!TRANSITIONS[currentStatus] || !TRANSITIONS[currentStatus].has(nextStatus)) {
    throw new Error(`invalid weekly state transition: ${currentStatus} -> ${nextStatus}`);
  }
}

function createWeeklyAttempt({ outputDir, meetingDate, reportDepth, attemptId, now }) {
  assertUuid(attemptId, "pipeline attempt ID");
  if (!Number.isInteger(reportDepth) || reportDepth < 1) {
    throw new Error("report depth must be a positive integer");
  }
  if (typeof now !== "function") throw new Error("now must be a function");
  const timestamp = now();
  const paths = buildWeeklyPipelinePaths(outputDir, meetingDate);
  makeWeeklyDirectories(paths);
  const state = {
    schemaVersion: 1,
    meetingDate,
    pipelineAttemptId: attemptId,
    reportDepth,
    status: "preparing",
    stage: "collect",
    startedAt: timestamp,
    updatedAt: timestamp,
    snapshotPath: null,
    snapshotHash: null,
    generationAttemptId: null,
    generationStatePath: null,
    reportPath: null,
    reportHash: null,
    expectedSectionHash: null,
    failureArtifact: null,
    published: null,
  };
  writeJsonDurableAtomic(paths.statusPath, state);
  return state;
}

function loadWeeklyStatus(outputDir, meetingDate) {
  const paths = buildWeeklyPipelinePaths(outputDir, meetingDate);
  const pipelineRoot = path.dirname(paths.meetingDir);
  assertNotSymlink(pipelineRoot, "weekly pipeline directory");
  if (!fs.existsSync(pipelineRoot)) return null;
  assertWeeklyPathOwnership(paths);
  if (!fs.existsSync(paths.meetingDir)) return null;
  return readWeeklyStatus(paths);
}

function patchWeeklyStatus(paths, expectedAttemptId, patch) {
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  if (
    patch
    && Object.prototype.hasOwnProperty.call(patch, "pipelineAttemptId")
    && patch.pipelineAttemptId !== current.pipelineAttemptId
  ) {
    throw new Error("weekly pipeline attempt ownership mismatch");
  }
  const statusRequested = patch && Object.prototype.hasOwnProperty.call(patch, "status");
  const nextStatus = statusRequested ? patch.status : current.status;
  if (statusRequested) assertTransition(current.status, nextStatus);
  const next = {
    ...current,
    ...patch,
    pipelineAttemptId: current.pipelineAttemptId,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
  writeJsonDurableAtomic(paths.statusPath, next);
  return next;
}

function markWeeklyReady(paths, expectedAttemptId, evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("weekly READY evidence is required");
  }
  for (const field of ["snapshotPath", "generationStatePath", "reportPath"]) {
    if (typeof evidence[field] !== "string" || !path.isAbsolute(evidence[field])) {
      throw new Error(`weekly READY ${field} must be an absolute path`);
    }
  }
  assertHash(evidence.snapshotHash, "weekly READY snapshot hash");
  assertUuid(evidence.generationAttemptId, "weekly READY generation attempt ID");
  assertHash(evidence.reportHash, "weekly READY report hash");
  return patchWeeklyStatus(paths, expectedAttemptId, {
    ...evidence,
    status: "ready",
    stage: "publish",
    expectedSectionHash: null,
    published: null,
  });
}

function markWeeklyPublishing(paths, expectedAttemptId) {
  return patchWeeklyStatus(paths, expectedAttemptId, {
    status: "publishing",
    stage: "publish",
    expectedSectionHash: null,
  });
}

function pinExpectedSectionHash(paths, expectedAttemptId, hash) {
  assertHash(hash, "expected section hash");
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  if (current.status !== "publishing") {
    throw new Error(`expected section hash requires publishing status, got ${current.status}`);
  }
  return patchWeeklyStatus(paths, expectedAttemptId, { expectedSectionHash: hash });
}

function markWeeklyPublished(paths, expectedAttemptId, published) {
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  assertTransition(current.status, "published");
  assertHash(current.expectedSectionHash, "pinned expected section hash");
  if (!published || published.sectionHash !== current.expectedSectionHash) {
    throw new Error("published section hash must match the pinned expected section hash");
  }
  return patchWeeklyStatus(paths, expectedAttemptId, {
    status: "published",
    stage: "publish_verify",
    published,
  });
}

module.exports = {
  buildWeeklyPipelinePaths,
  createWeeklyAttempt,
  loadWeeklyStatus,
  patchWeeklyStatus,
  markWeeklyReady,
  markWeeklyPublishing,
  pinExpectedSectionHash,
  markWeeklyPublished,
};
