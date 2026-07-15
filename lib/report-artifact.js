const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SNAPSHOT_SCHEMA_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashObject(value) {
  return sha256(stableStringify(value));
}

function snapshotHashPayload(snapshot) {
  const {
    collectedAt: _collectedAt,
    contentHash: _contentHash,
    path: _path,
    ...content
  } = snapshot;
  return content;
}

function computeSnapshotHash(snapshot) {
  return hashObject(snapshotHashPayload(snapshot));
}

function buildSnapshotPath(meetingDate, config) {
  if (config.env.snapshotPath) return path.resolve(config.env.snapshotPath);
  const date = typeof meetingDate === "string"
    ? meetingDate.slice(0, 10)
    : [
      meetingDate.getFullYear(),
      String(meetingDate.getMonth() + 1).padStart(2, "0"),
      String(meetingDate.getDate()).padStart(2, "0"),
    ].join("-");
  return path.join(config.env.outputDir, `report-${date}.snapshot.json`);
}

function buildValidationPath(reportPath) {
  return /\.md$/i.test(reportPath)
    ? reportPath.replace(/\.md$/i, ".validation.json")
    : `${reportPath}.validation.json`;
}

function buildCandidatesPath(meetingDate, config) {
  const date = typeof meetingDate === "string"
    ? meetingDate.slice(0, 10)
    : [
      meetingDate.getFullYear(),
      String(meetingDate.getMonth() + 1).padStart(2, "0"),
      String(meetingDate.getDate()).padStart(2, "0"),
    ].join("-");
  return path.join(config.env.outputDir, `presentation-candidates-${date}.json`);
}

function buildPublishedPath(reportPath) {
  return /\.md$/i.test(reportPath)
    ? reportPath.replace(/\.md$/i, ".published.md")
    : `${reportPath}.published.md`;
}

function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

function sealSnapshot(snapshot) {
  const sealed = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ...snapshot,
    status: snapshot.status || "sealed",
  };
  sealed.contentHash = computeSnapshotHash(sealed);
  return sealed;
}

function verifySnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot schema: ${snapshot && snapshot.schemaVersion}`);
  }
  const actual = computeSnapshotHash(snapshot);
  if (snapshot.contentHash !== actual) {
    throw new Error(`Snapshot hash mismatch: expected ${snapshot.contentHash}, got ${actual}`);
  }
  return snapshot;
}

function readSnapshot(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`수집 snapshot이 없습니다: ${filePath}`);
  }
  const snapshot = verifySnapshot(JSON.parse(fs.readFileSync(filePath, "utf8")));
  if (snapshot.status !== "sealed" && !options.allowPartial) {
    throw new Error(`Snapshot status=${snapshot.status}; sealed snapshot만 사용할 수 있습니다.`);
  }
  return snapshot;
}

function archiveSnapshot(filePath, snapshot) {
  const archived = filePath.replace(/\.snapshot\.json$/, `.${snapshot.contentHash.slice(0, 12)}.snapshot.json`);
  if (!fs.existsSync(archived)) fs.copyFileSync(filePath, archived);
  return archived;
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  archiveSnapshot,
  buildCandidatesPath,
  buildPublishedPath,
  buildSnapshotPath,
  buildValidationPath,
  canonicalize,
  computeSnapshotHash,
  hashObject,
  readSnapshot,
  sealSnapshot,
  sha256,
  stableStringify,
  verifySnapshot,
  writeJsonAtomic,
  writeTextAtomic,
};
