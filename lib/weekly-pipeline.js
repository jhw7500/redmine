const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildRunPaths, writeImmutableArtifact } = require("./report-run");
const { buildGenerationStatePath, sha256, verifySnapshot } = require("./report-artifact");
const { isPublishable } = require("./report-publishability");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FAILURE_MESSAGE_LIMIT = 500;
const FAILURE_ISSUE_LIMIT = 500;
const FAILURE_STACK_LIMIT = 2000;
const READY_EVIDENCE_ERROR_CODES = new Set([
  "attempt_ownership_mismatch",
  "catalog_hash_mismatch",
  "clean_report_hash_mismatch",
  "coverage_catalog_hash_mismatch",
  "report_hash_mismatch",
  "run_path_mismatch",
  "snapshot_hash_mismatch",
  "source_records_hash_mismatch",
  "validation_path_mismatch",
]);
const TRANSITIONS = {
  preparing: new Set(["ready", "failed"]),
  ready: new Set(["publishing", "failed"]),
  publishing: new Set(["published", "failed"]),
};
const IMMUTABLE_STATE_FIELDS = new Set([
  "schemaVersion",
  "meetingDate",
  "pipelineAttemptId",
  "reportDepth",
  "startedAt",
  "updatedAt",
]);
const MUTABLE_STATE_FIELDS = new Set([
  "status",
  "stage",
  "snapshotPath",
  "snapshotHash",
  "generationAttemptId",
  "generationStatePath",
  "reportPath",
  "reportHash",
  "expectedSectionHash",
  "published",
]);
const PUBLIC_PATCH_FIELDS = new Set(["status", "stage"]);
const FAILURE_PATCH_FIELDS = new Set(["status", "stage", "failureArtifact"]);
const STATE_FIELDS = new Set([
  ...IMMUTABLE_STATE_FIELDS,
  ...MUTABLE_STATE_FIELDS,
  "failureArtifact",
]);
const READY_EVIDENCE_FIELDS = new Set([
  "snapshotPath",
  "snapshotHash",
  "generationAttemptId",
  "generationStatePath",
  "reportPath",
  "reportHash",
]);
const VALID_STATUSES = new Set([
  "preparing",
  "ready",
  "publishing",
  "published",
  "failed",
]);
const VALID_STAGES = new Set([
  "collect",
  "generate",
  "validate",
  "publish",
  "publish_verify",
]);

function formatWeeklyPrepareRetryCommand(meetingDate) {
  if (typeof meetingDate !== "string" || !DATE_RE.test(meetingDate)) {
    throw new Error("meeting date must be YYYY-MM-DD");
  }
  return `rtk env MEETING_DATE=${meetingDate} ./run-weekly-prepare-env.sh`;
}

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

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
}

function assertContainedPath(rootPath, candidatePath, label) {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes configured output directory`);
  }
  return relative;
}

function assertOwnedEvidenceFile(paths, filePath, label) {
  const { outputRoot, resolvedFilePath, relative } = assertOwnedEvidenceReference(
    paths,
    filePath,
    label
  );
  let cursor = outputRoot;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch (error) {
      throw new Error(`${label} is missing or unreadable: ${resolvedFilePath}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} evidence path must not contain a symlink`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`${label} evidence parent must be a directory`);
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new Error(`${label} evidence path must be a regular file`);
    }
  }

  const realOutputRoot = fs.realpathSync(outputRoot);
  const realFilePath = fs.realpathSync(resolvedFilePath);
  assertContainedPath(realOutputRoot, realFilePath, label);
}

function assertOwnedEvidenceReference(paths, filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute evidence path`);
  }
  const outputRoot = path.dirname(path.dirname(paths.meetingDir));
  const resolvedFilePath = path.resolve(filePath);
  const relative = assertContainedPath(outputRoot, resolvedFilePath, label);
  return { outputRoot, resolvedFilePath, relative };
}

function assertWeeklyStateSchema(paths, state, { allowUnavailableEvidence = false } = {}) {
  for (const field of Object.keys(state)) {
    if (!STATE_FIELDS.has(field)) throw new Error(`unsupported weekly state field: ${field}`);
  }
  if (state.schemaVersion !== 1) throw new Error("weekly state schemaVersion is immutable");
  if (state.meetingDate !== path.basename(paths.meetingDir)) {
    throw new Error("weekly state meetingDate ownership mismatch");
  }
  assertUuid(state.pipelineAttemptId, "pipeline attempt ID");
  if (!Number.isInteger(state.reportDepth) || state.reportDepth < 1) {
    throw new Error("weekly state reportDepth must be a positive integer");
  }
  assertIsoTimestamp(state.startedAt, "weekly state startedAt");
  assertIsoTimestamp(state.updatedAt, "weekly state updatedAt");
  if (!VALID_STATUSES.has(state.status)) throw new Error("weekly state status is invalid");
  if (!VALID_STAGES.has(state.stage)) throw new Error("weekly state stage is invalid");

  for (const field of ["snapshotPath", "generationStatePath", "reportPath"]) {
    if (state[field] !== null) {
      const validate = allowUnavailableEvidence || state.status === "failed"
        ? assertOwnedEvidenceReference
        : assertOwnedEvidenceFile;
      validate(paths, state[field], `weekly ${field}`);
    }
  }
  if (state.snapshotHash !== null) assertHash(state.snapshotHash, "weekly snapshot hash");
  if (state.generationAttemptId !== null) {
    assertUuid(state.generationAttemptId, "weekly generation attempt ID");
  }
  if (state.reportHash !== null) assertHash(state.reportHash, "weekly report hash");
  if (state.expectedSectionHash !== null) {
    assertHash(state.expectedSectionHash, "expected section hash");
  }
  if (state.failureArtifact !== null) {
    assertOwnedEvidenceFile(paths, state.failureArtifact, "weekly failure artifact");
  }
  if (state.published !== null && (!state.published || typeof state.published !== "object")) {
    throw new Error("weekly published evidence must be an object or null");
  }
  if (["ready", "publishing", "published"].includes(state.status)) {
    for (const field of READY_EVIDENCE_FIELDS) {
      if (state[field] === null) throw new Error(`weekly READY evidence requires ${field}`);
    }
  }
  if (state.status === "ready" && state.expectedSectionHash !== null) {
    throw new Error("weekly READY expectedSectionHash must be null");
  }
  if (["ready", "publishing"].includes(state.status) && state.published !== null) {
    throw new Error(`weekly ${state.status} published evidence must be null`);
  }
  if (state.status === "published") {
    assertHash(state.expectedSectionHash, "pinned expected section hash");
    if (!state.published || state.published.sectionHash !== state.expectedSectionHash) {
      throw new Error("published section hash must match the pinned expected section hash");
    }
  }
  if (state.status === "failed" && state.failureArtifact === null) {
    throw new Error("weekly failed state requires failureArtifact");
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
  assertWeeklyStateSchema(paths, state);
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

function writeWeeklyStatusPatch(paths, expectedAttemptId, patch, allowedFields) {
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("weekly state patch must be an object");
  }
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE_STATE_FIELDS.has(field)) {
      if (field === "pipelineAttemptId") {
        throw new Error("weekly pipeline attempt ownership mismatch");
      }
      throw new Error(`weekly state ${field} is immutable`);
    }
    if (!allowedFields.has(field)) {
      throw new Error(`unsupported weekly state patch field: ${field}`);
    }
  }
  const statusRequested = Object.prototype.hasOwnProperty.call(patch, "status");
  const nextStatus = statusRequested ? patch.status : current.status;
  if (statusRequested) assertTransition(current.status, nextStatus);
  const next = {
    ...current,
    ...patch,
    pipelineAttemptId: current.pipelineAttemptId,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
  assertWeeklyStateSchema(paths, next);
  writeJsonDurableAtomic(paths.statusPath, next);
  return next;
}

function patchWeeklyStatus(paths, expectedAttemptId, patch) {
  return writeWeeklyStatusPatch(paths, expectedAttemptId, patch, PUBLIC_PATCH_FIELDS);
}

function markWeeklyReady(paths, expectedAttemptId, evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("weekly READY evidence is required");
  }
  for (const field of Object.keys(evidence)) {
    if (!READY_EVIDENCE_FIELDS.has(field)) {
      throw new Error(`unsupported weekly READY evidence field: ${field}`);
    }
  }
  for (const field of READY_EVIDENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(evidence, field)) {
      throw new Error(`weekly READY evidence requires ${field}`);
    }
  }
  return writeWeeklyStatusPatch(paths, expectedAttemptId, {
    ...evidence,
    status: "ready",
    stage: "publish",
    expectedSectionHash: null,
    published: null,
  }, MUTABLE_STATE_FIELDS);
}

function markWeeklyPublishing(paths, expectedAttemptId) {
  return writeWeeklyStatusPatch(paths, expectedAttemptId, {
    status: "publishing",
    stage: "publish",
    expectedSectionHash: null,
  }, MUTABLE_STATE_FIELDS);
}

function pinExpectedSectionHash(paths, expectedAttemptId, hash) {
  assertHash(hash, "expected section hash");
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  if (current.status !== "publishing") {
    throw new Error(`expected section hash requires publishing status, got ${current.status}`);
  }
  return writeWeeklyStatusPatch(
    paths,
    expectedAttemptId,
    { expectedSectionHash: hash },
    MUTABLE_STATE_FIELDS
  );
}

function markWeeklyPublished(paths, expectedAttemptId, published) {
  const current = readWeeklyStatus(paths);
  assertOwned(current, expectedAttemptId);
  assertTransition(current.status, "published");
  assertHash(current.expectedSectionHash, "pinned expected section hash");
  if (!published || published.sectionHash !== current.expectedSectionHash) {
    throw new Error("published section hash must match the pinned expected section hash");
  }
  return writeWeeklyStatusPatch(paths, expectedAttemptId, {
    status: "published",
    stage: "publish_verify",
    published,
  }, MUTABLE_STATE_FIELDS);
}

function redactWeeklyText(value, limit) {
  let text = typeof value === "string" ? value : String(value || "");
  text = text
    .replace(/(["']?X-Redmine-API-Key["']?\s*[:=]\s*["']?)[^"'\s,;}]+(["']?)/gi,
      "$1[REDACTED]$2")
    .replace(/(["']?Authorization["']?\s*:\s*["']?(?:Bearer|Basic|token)\s+)[^"'\s,;}]+(["']?)/gi,
      "$1[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/gi, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, "$1[REDACTED]@");
  if (text.length > limit) return `${text.slice(0, limit - 1)}…`;
  return text;
}

function failureDetailCode(error) {
  if (!error || typeof error.code !== "string" || error.code.length === 0) return null;
  return redactWeeklyText(error.code, 100);
}

function aggregateValidationIssues(validation) {
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];
  const normalized = issues
    .filter((issue) => issue && typeof issue.code === "string" && issue.code.length > 0)
    .map((issue) => {
      const representative = {
        code: redactWeeklyText(issue.code, 100),
      };
      for (const field of ["severity", "message", "value", "path"]) {
        if (typeof issue[field] === "string") {
          representative[field] = redactWeeklyText(issue[field], FAILURE_ISSUE_LIMIT);
        }
      }
      for (const field of ["line", "column"]) {
        if (Number.isInteger(issue[field])) representative[field] = issue[field];
      }
      return representative;
    });
  const counts = new Map();
  for (const issue of normalized) counts.set(issue.code, (counts.get(issue.code) || 0) + 1);
  const codeOrder = [...counts].sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  ));
  const rank = new Map(codeOrder.map(([code], index) => [code, index]));
  normalized.sort((left, right) => (
    rank.get(left.code) - rank.get(right.code)
    || JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
  return {
    issueCounts: Object.fromEntries(codeOrder),
    representativeIssues: normalized.slice(0, 3),
    primaryIssueCode: codeOrder.length > 0 ? codeOrder[0][0] : null,
  };
}

function classifyWeeklyFailure({ stage, error, validation } = {}) {
  const detailCode = failureDetailCode(error);
  const aggregation = aggregateValidationIssues(validation);
  let code;
  let primaryIssueCode;

  if (stage === "collect") {
    code = "collect_failed";
    primaryIssueCode = detailCode || code;
  } else if (stage === "generate") {
    if (
      detailCode
      && (detailCode.startsWith("SOURCE_SELECTION_") || detailCode.startsWith("SOURCE_RECORDS_"))
    ) {
      code = "source_selection_invalid";
    } else {
      code = "ai_failed";
    }
    primaryIssueCode = detailCode || code;
  } else if (stage === "validate") {
    code = "validation_failed";
    primaryIssueCode = aggregation.primaryIssueCode || detailCode || code;
  } else if (stage === "publish_verify") {
    code = "publish_verify_mismatch";
    primaryIssueCode = code;
  } else if (stage === "publish") {
    if (detailCode === "prepare_incomplete") code = "prepare_incomplete";
    else if (detailCode === "publish_incomplete") code = "publish_incomplete";
    else if (
      detailCode === "ready_evidence_mismatch"
      || (detailCode && READY_EVIDENCE_ERROR_CODES.has(detailCode))
    ) {
      code = "ready_evidence_mismatch";
    } else code = "publish_http_failed";
    primaryIssueCode = detailCode || code;
  } else if (detailCode && detailCode.startsWith("AI_")) {
    code = "ai_failed";
    primaryIssueCode = detailCode;
  } else if (
    detailCode
    && (detailCode.startsWith("SOURCE_SELECTION_") || detailCode.startsWith("SOURCE_RECORDS_"))
  ) {
    code = "source_selection_invalid";
    primaryIssueCode = detailCode;
  } else {
    code = detailCode || "prepare_incomplete";
    primaryIssueCode = detailCode || code;
  }

  const rawCause = error && typeof error.message === "string"
    ? error.message
    : aggregation.representativeIssues[0] && aggregation.representativeIssues[0].message
      ? aggregation.representativeIssues[0].message
      : primaryIssueCode;
  return {
    code,
    primaryIssueCode,
    cause: redactWeeklyText(rawCause, FAILURE_MESSAGE_LIMIT).replace(/\s+/g, " ").trim(),
    issueCounts: aggregation.issueCounts,
    representativeIssues: aggregation.representativeIssues,
  };
}

function formatWeeklyFailureLog(failure, markdownPath) {
  const stagesByCode = {
    collect_failed: "collect",
    ai_failed: "generate",
    source_selection_invalid: "generate",
    validation_failed: "validate",
    prepare_incomplete: "publish",
    ready_evidence_mismatch: "publish",
    publish_http_failed: "publish",
    publish_incomplete: "publish",
    publish_verify_mismatch: "publish_verify",
  };
  const stage = redactWeeklyText(
    failure && (failure.stage || stagesByCode[failure.code]),
    50
  ).replace(/\s+/g, " ");
  const code = redactWeeklyText(
    failure && (failure.primaryIssueCode || failure.code),
    100
  ).replace(/\s+/g, " ");
  const cause = redactWeeklyText(
    failure && (failure.cause || failure.message),
    FAILURE_MESSAGE_LIMIT
  )
    .replace(/\s+/g, " ")
    .trim();
  return `[weekly][FAIL] stage=${stage} code=${code} cause=${JSON.stringify(cause)} artifact=${markdownPath}`;
}

function formatWeeklySkipLog(state) {
  if (state && state.status === "published") return "[weekly][SKIP] already-published";
  const status = state && state.status ? state.status : "missing";
  const artifact = state && state.failureArtifact ? ` artifact=${state.failureArtifact}` : "";
  return `[weekly][SKIP] status=${status}${artifact}`;
}

function normalizeSection(value) {
  return String(value).trimEnd() + "\n";
}

function weeklyPublishError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function assertWeeklyReadyEvidence(paths, state, config, meetingDate) {
  const { assertV2PublishEvidence } = require("../index");
  try {
    assertWeeklyStateSchema(paths, state);
    if (state.reportDepth !== 3) throw new Error("weekly READY requires depth 3");
    const read = (filePath, label) => {
      assertOwnedEvidenceFile(paths, filePath, label);
      return fs.readFileSync(filePath, "utf8");
    };
    const snapshotText = read(state.snapshotPath, "weekly snapshot");
    const reportContent = read(state.reportPath, "weekly report");
    const generationText = read(state.generationStatePath, "weekly generation state");
    const snapshot = verifySnapshot(JSON.parse(snapshotText));
    const generation = JSON.parse(generationText);
    if (snapshot.status !== "sealed" || snapshot.meetingDate !== state.meetingDate
      || snapshot.contentHash !== state.snapshotHash || sha256(reportContent) !== state.reportHash
      || state.generationStatePath !== buildGenerationStatePath(state.reportPath)
      || generation.attemptId !== state.generationAttemptId || generation.schemaVersion !== 2
      || generation.status !== "complete" || generation.generationMethod !== "source_selection"
      || generation.reportDepth !== 3) {
      throw new Error("weekly READY metadata or hash mismatch");
    }
    const runPaths = buildRunPaths(config.env.outputDir, state.meetingDate, state.generationAttemptId);
    const inputs = new Map();
    // Check ownership before the v2 validator reads or hashes any run artifact.
    for (const [key, filePath] of Object.entries(runPaths)) {
      if (key.endsWith("Path") && fs.existsSync(filePath)) inputs.set(filePath, read(filePath, `weekly ${key}`));
    }
    if (typeof generation.latestValidationPath !== "string"
      || path.basename(generation.latestValidationPath) !== generation.latestValidationPath) {
      throw new Error("weekly latest validation path must belong to its generation run");
    }
    for (const name of ["source-records.json", "source-selection.json", generation.latestValidationPath]) {
      const filePath = path.join(runPaths.runDir, name);
      inputs.set(filePath, read(filePath, `weekly ${name}`));
    }
    const evidence = assertV2PublishEvidence({ state: generation, snapshot, reportContent, meetingDate, config });
    if (!isPublishable(evidence.validation)) throw new Error("latest validation is not publishable");
    if (read(state.snapshotPath, "weekly snapshot") !== snapshotText
      || read(state.reportPath, "weekly report") !== reportContent
      || read(state.generationStatePath, "weekly generation state") !== generationText) {
      throw new Error("weekly READY evidence changed during verification");
    }
    for (const [filePath, content] of inputs) {
      if (read(filePath, "weekly run input") !== content) throw new Error("weekly run input changed during verification");
    }
    return evidence;
  } catch (error) {
    throw weeklyPublishError("ready_evidence_mismatch", `weekly READY evidence mismatch: ${error.message}`, error);
  }
}

async function runWeeklyPublish(config, meetingDate, dependencies = {}) {
  const { assertWeeklyProfile, runUpdate } = require("../index");
  const { formatDate } = require("./publisher");
  const date = formatDate(meetingDate);
  const paths = buildWeeklyPipelinePaths(config.env.outputDir, date);
  let state = loadWeeklyStatus(config.env.outputDir, date);
  if (state && ["failed", "published"].includes(state.status)) {
    console.log(formatWeeklySkipLog(state));
    return { skipped: true, reason: state.status === "published" ? "already-published" : state.failureArtifact,
      state, updateResult: null };
  }
  assertWeeklyProfile(config, "weekly-publish");
  const now = dependencies.now || (() => new Date().toISOString());
  if (!state) state = createWeeklyAttempt({ outputDir: config.env.outputDir, meetingDate: date,
    reportDepth: 3, attemptId: (dependencies.randomUUID || crypto.randomUUID)(), now });
  const attemptId = state.pipelineAttemptId;
  let externalWriteBoundary = state.status === "publishing";
  let finalSectionPinned = false;
  let stage = "publish";
  try {
    if (state.status === "preparing") throw weeklyPublishError("prepare_incomplete", "weekly prepare is incomplete");
    if (state.status === "publishing") throw weeklyPublishError("publish_incomplete", "weekly publication was interrupted; verify the remote section before preparing again");
    if (state.status !== "ready") throw weeklyPublishError("ready_evidence_mismatch", "weekly READY state is required");
    const publishConfig = { ...config, env: { ...config.env,
      snapshotPath: state.snapshotPath, outputPath: state.reportPath } };
    const readyState = state;
    const revalidate = () => {
      const current = readWeeklyStatus(paths);
      assertOwned(current, attemptId);
      if (!["ready", "publishing"].includes(current.status)
        || [...READY_EVIDENCE_FIELDS, "reportDepth", "meetingDate"].some((key) => current[key] !== readyState[key])) {
        throw weeklyPublishError("ready_evidence_mismatch", "weekly READY identity or evidence changed before publication");
      }
      return assertWeeklyReadyEvidence(paths, current, publishConfig, meetingDate);
    };
    assertWeeklyReadyEvidence(paths, state, publishConfig, meetingDate);
    const verifyRemote = (publication) => {
      stage = "publish_verify";
      const current = readWeeklyStatus(paths);
      assertOwned(current, attemptId);
      if (!publication || typeof publication.finalSection !== "string"
        || !publication.remote || typeof publication.remote.section !== "string"
        || !finalSectionPinned || current.status !== "publishing"
        || sha256(normalizeSection(publication.finalSection)) !== current.expectedSectionHash
        || normalizeSection(publication.remote.section) !== normalizeSection(publication.finalSection)) {
        throw weeklyPublishError("publish_verify_mismatch", "remote Wiki section does not exactly match the pinned final section");
      }
      return current;
    };
    const updateResult = await (dependencies.runUpdate || runUpdate)(publishConfig, meetingDate, {
      assertReady: revalidate,
      verifyRemote,
      onBeforeExternalWrite: () => {
        const current = readWeeklyStatus(paths);
        assertOwned(current, attemptId);
        if (current.status !== "ready") throw weeklyPublishError("ready_evidence_mismatch", "weekly READY state changed before publication");
        revalidate();
        state = markWeeklyPublishing(paths, attemptId);
        externalWriteBoundary = true;
      },
      onFinalSection: ({ finalSection }) => {
        state = pinExpectedSectionHash(paths, attemptId, sha256(normalizeSection(finalSection)));
        finalSectionPinned = true;
      },
    });
    const publication = updateResult && updateResult.publication;
    const current = verifyRemote(publication);
    state = markWeeklyPublished(paths, attemptId, {
      wikiTitle: publication.wikiTitle,
      version: publication.remote.version,
      updatedOn: publication.remote.updatedOn,
      sectionHash: current.expectedSectionHash,
      verifiedAt: now(),
    });
    return { skipped: false, reason: null, state, updateResult };
  } catch (error) {
    const serverState = error.serverState === "written_unverified" || stage === "publish_verify"
      || error.code === "publish_incomplete"
      ? "written_unverified" : "unchanged";
    const recorded = recordWeeklyFailure({ paths, state, stage, error, artifacts: [],
      redmineWriteAttempted: externalWriteBoundary, serverState,
      recoverReadyEvidence: error.code === "ready_evidence_mismatch" && state.status === "ready",
      retryCommand: formatWeeklyPrepareRetryCommand(date), now });
    console.error(formatWeeklyFailureLog(recorded.failure, recorded.markdownPath));
    error.weeklyFailure = recorded;
    throw error;
  }
}

function makeWeeklyFailureDirectory(paths) {
  assertWeeklyPathOwnership(paths);
  const stats = assertNotSymlink(paths.failuresDir, "weekly failures directory");
  if (stats && !stats.isDirectory()) {
    throw new Error("weekly failures path must be a directory");
  }
  if (!stats) fs.mkdirSync(paths.failuresDir);
  assertNotSymlink(paths.failuresDir, "weekly failures directory");
  const outputRoot = path.dirname(path.dirname(paths.meetingDir));
  const realOutputRoot = fs.realpathSync(outputRoot);
  const realFailuresDir = fs.realpathSync(paths.failuresDir);
  assertContainedPath(realOutputRoot, realFailuresDir, "weekly failures directory");
}

function inspectFailureArtifact(paths, candidatePath) {
  if (typeof candidatePath !== "string" || !path.isAbsolute(candidatePath)) {
    throw new Error("weekly failure artifact must be an absolute path");
  }
  const outputRoot = path.dirname(path.dirname(paths.meetingDir));
  const resolvedPath = path.resolve(candidatePath);
  const relative = assertContainedPath(outputRoot, resolvedPath, "weekly failure artifact");
  let cursor = outputRoot;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error("weekly failure artifact path must not contain a symlink");
    }
    if (index < segments.length - 1 && !stats.isDirectory()) return null;
    if (index === segments.length - 1 && !stats.isFile()) return null;
  }
  const realOutputRoot = fs.realpathSync(outputRoot);
  const realPath = fs.realpathSync(resolvedPath);
  assertContainedPath(realOutputRoot, realPath, "weekly failure artifact");
  return {
    path: realPath,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(realPath)).digest("hex"),
  };
}

function discoverFailureArtifacts(paths, artifacts) {
  if (artifacts === undefined || artifacts === null) return [];
  if (!Array.isArray(artifacts)) throw new Error("weekly failure artifacts must be an array");
  const discovered = new Map();
  for (const candidatePath of artifacts) {
    const artifact = inspectFailureArtifact(paths, candidatePath);
    if (artifact) discovered.set(artifact.path, artifact);
  }
  return [...discovered.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function weeklyFailureTimestamp(timestamp) {
  assertIsoTimestamp(timestamp, "weekly failure occurredAt");
  return timestamp.replace(/[-:.]/g, "");
}

function renderWeeklyFailureMarkdown(failure) {
  const lines = [
    "# Weekly Pipeline Failure",
    "",
    `Stage: ${failure.stage}`,
    `Cause: ${failure.message}`,
    "",
    "## Issue counts",
    "",
  ];
  const issueCountEntries = Object.entries(failure.issueCounts);
  if (issueCountEntries.length === 0) lines.push("- None");
  else for (const [code, count] of issueCountEntries) lines.push(`- ${code}: ${count}`);
  lines.push("", "## Representative issues", "");
  if (failure.representativeIssues.length === 0) lines.push("- None");
  else {
    for (const issue of failure.representativeIssues) {
      const detail = issue.message || issue.value || issue.path || "no detail";
      lines.push(`- ${issue.code}: ${String(detail).replace(/\s+/g, " ")}`);
    }
  }
  lines.push(
    "",
    "## Server state",
    "",
    `- Redmine write attempted: ${failure.redmineWriteAttempted}`,
    `- State: ${failure.serverState}`,
    "",
    "## Artifacts",
    ""
  );
  if (failure.artifacts.length === 0) lines.push("- None");
  else {
    for (const artifact of failure.artifacts) {
      lines.push(`- ${artifact.path} (sha256: ${artifact.sha256})`);
    }
  }
  lines.push("", "## Retry", "", "```sh", failure.retryCommand, "```", "");
  return lines.join("\n");
}

function recordWeeklyFailure({
  paths,
  state,
  stage,
  error,
  validation,
  artifacts,
  redmineWriteAttempted,
  serverState,
  retryCommand,
  now,
  recoverReadyEvidence = false,
}) {
  assertWeeklyPathOwnership(paths);
  if (!state || typeof state !== "object") throw new Error("weekly state is required");
  const current = readWeeklyStatus(paths);
  assertOwned(current, state.pipelineAttemptId);
  if (recoverReadyEvidence) {
    if (state.status !== "ready" || current.status !== "ready" || error.code !== "ready_evidence_mismatch") {
      throw new Error("weekly READY recovery requires an owned READY mismatch");
    }
    // Invalid READY references must never be read or hashed while recording failure.
    // Retain the owned attempt and timestamps; the failure message explains the mismatch.
    state = { ...current, meetingDate: path.basename(paths.meetingDir), status: "preparing",
      snapshotPath: null, snapshotHash: null, generationStatePath: null, generationAttemptId: null,
      reportPath: null, reportHash: null, expectedSectionHash: null, published: null };
    artifacts = [];
  } else {
    assertWeeklyStateSchema(paths, current, { allowUnavailableEvidence: true });
  }
  assertWeeklyStateSchema(paths, state, { allowUnavailableEvidence: true });
  if (!VALID_STAGES.has(stage)) throw new Error("weekly failure stage is invalid");
  if (typeof now !== "function") throw new Error("now must be a function");
  if (typeof redmineWriteAttempted !== "boolean") {
    throw new Error("redmineWriteAttempted must be a boolean");
  }
  if (!["unchanged", "written_unverified", "verified"].includes(serverState)) {
    throw new Error("weekly failure serverState is invalid");
  }
  if (typeof retryCommand !== "string" || retryCommand.length === 0 || /[\r\n]/.test(retryCommand)) {
    throw new Error("weekly failure retryCommand must be one line");
  }
  const occurredAt = now();
  const timestamp = weeklyFailureTimestamp(occurredAt);
  const classification = classifyWeeklyFailure({ stage, error, validation });
  const artifactRecords = discoverFailureArtifacts(paths, artifacts);
  const failure = {
    schemaVersion: 1,
    meetingDate: state.meetingDate,
    pipelineAttemptId: state.pipelineAttemptId,
    occurredAt,
    stage,
    code: classification.code,
    primaryIssueCode: classification.primaryIssueCode,
    message: classification.cause,
    stack: error && typeof error.stack === "string"
      ? redactWeeklyText(error.stack, FAILURE_STACK_LIMIT)
      : null,
    issueCounts: classification.issueCounts,
    representativeIssues: classification.representativeIssues,
    artifacts: artifactRecords,
    redmineWriteAttempted,
    serverState,
    retryCommand,
  };
  makeWeeklyFailureDirectory(paths);
  const baseName = `${timestamp}-${stage}-${state.pipelineAttemptId}`;
  const jsonPath = path.join(paths.failuresDir, `${baseName}.json`);
  const markdownPath = path.join(paths.failuresDir, `${baseName}.md`);
  assertContainedPath(paths.failuresDir, jsonPath, "weekly failure JSON path");
  assertContainedPath(paths.failuresDir, markdownPath, "weekly failure Markdown path");
  assertNotSymlink(jsonPath, "weekly failure JSON file");
  assertNotSymlink(markdownPath, "weekly failure Markdown file");
  writeImmutableArtifact(jsonPath, `${JSON.stringify(failure, null, 2)}\n`);
  assertNotSymlink(paths.failuresDir, "weekly failures directory");
  writeImmutableArtifact(markdownPath, renderWeeklyFailureMarkdown(failure));

  let failedState;
  try {
    if (recoverReadyEvidence) {
      const latest = readWeeklyStatus(paths);
      assertOwned(latest, state.pipelineAttemptId);
      assertTransition(latest.status, "failed");
      if (latest.status !== "ready") throw new Error("weekly READY recovery state changed");
      failedState = { ...state, status: "failed", stage, failureArtifact: markdownPath,
        updatedAt: new Date().toISOString() };
      assertWeeklyStateSchema(paths, failedState);
      writeJsonDurableAtomic(paths.statusPath, failedState);
    } else {
      failedState = writeWeeklyStatusPatch(paths, state.pipelineAttemptId, {
        status: "failed", stage, failureArtifact: markdownPath,
      }, FAILURE_PATCH_FIELDS);
    }
  } catch (persistenceError) {
    persistenceError.jsonPath = jsonPath;
    persistenceError.markdownPath = markdownPath;
    throw persistenceError;
  }
  return { state: failedState, jsonPath, markdownPath, failure };
}

module.exports = {
  formatWeeklyPrepareRetryCommand,
  buildWeeklyPipelinePaths,
  createWeeklyAttempt,
  loadWeeklyStatus,
  patchWeeklyStatus,
  markWeeklyReady,
  markWeeklyPublishing,
  pinExpectedSectionHash,
  markWeeklyPublished,
  classifyWeeklyFailure,
  recordWeeklyFailure,
  formatWeeklyFailureLog,
  formatWeeklySkipLog,
  runWeeklyPublish,
};
