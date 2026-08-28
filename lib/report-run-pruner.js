const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(["running", "ai_complete"]);
const TERMINAL_STATUSES = new Set(["complete", "validation_failed"]);

function incrementReason(summary, reason) {
  summary.skipped += 1;
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
}

function readEntries(directory, summary) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    summary.errors += 1;
    return [];
  }
}

function resolveRealDirectory(entryPath, expectedParent, summary) {
  let stats;
  let realEntry;
  try {
    stats = fs.lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      incrementReason(summary, "symlink");
      return null;
    }
    if (!stats.isDirectory()) {
      incrementReason(summary, "not_directory");
      return null;
    }
    realEntry = fs.realpathSync(entryPath);
  } catch (error) {
    incrementReason(summary, "unreadable_path");
    return null;
  }
  if (path.dirname(realEntry) !== expectedParent) {
    incrementReason(summary, "path_escape");
    return null;
  }
  return realEntry;
}

function readRunState(runDir, summary) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  } catch (error) {
    incrementReason(summary, "invalid_state");
    return null;
  }
}

function validationLockBusy(runDir, summary) {
  const lockPath = path.join(runDir, ".validation.lock");
  if (!fs.existsSync(lockPath)) return false;
  try {
    if (fs.lstatSync(lockPath).isSymbolicLink()) {
      incrementReason(summary, "invalid_lock");
      return true;
    }
  } catch (error) {
    incrementReason(summary, "invalid_lock");
    return true;
  }
  const probe = spawnSync("flock", ["-n", lockPath, "true"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return false;
  if (!probe.error && probe.status === 1) {
    incrementReason(summary, "locked");
    return true;
  }
  summary.errors += 1;
  incrementReason(summary, "lock_probe_failed");
  return true;
}

function pruneRunArtifacts({ outputDir, retentionDays, dryRun, now = new Date() }) {
  const summary = {
    examined: 0,
    eligible: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    skippedReasons: {},
  };
  const cutoff = now.getTime() - (retentionDays * DAY_MS);
  const runsRoot = path.join(outputDir, "runs");

  if (!fs.existsSync(runsRoot)) return summary;

  let realOutputDir;
  let realRunsRoot;
  try {
    const rootStats = fs.lstatSync(runsRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      summary.errors += 1;
      return summary;
    }
    realOutputDir = fs.realpathSync(outputDir);
    realRunsRoot = fs.realpathSync(runsRoot);
  } catch (error) {
    summary.errors += 1;
    return summary;
  }
  if (path.dirname(realRunsRoot) !== realOutputDir) {
    summary.errors += 1;
    return summary;
  }

  for (const dateEntry of readEntries(runsRoot, summary)) {
    if (!DATE_RE.test(dateEntry.name)) {
      incrementReason(summary, "invalid_date");
      continue;
    }
    const dateDir = path.join(runsRoot, dateEntry.name);
    const realDateDir = resolveRealDirectory(dateDir, realRunsRoot, summary);
    if (!realDateDir) continue;
    for (const runEntry of readEntries(dateDir, summary)) {
      const runDir = path.join(dateDir, runEntry.name);
      summary.examined += 1;
      if (!UUID_RE.test(runEntry.name)) {
        incrementReason(summary, "invalid_run_id");
        continue;
      }
      if (!resolveRealDirectory(runDir, realDateDir, summary)) continue;
      const state = readRunState(runDir, summary);
      if (!state) continue;
      if (state.attemptId !== runEntry.name) {
        incrementReason(summary, "owner_mismatch");
        continue;
      }
      if (ACTIVE_STATUSES.has(state.status)) {
        incrementReason(summary, "active_state");
        continue;
      }
      if (!TERMINAL_STATUSES.has(state.status)) {
        incrementReason(summary, "invalid_status");
        continue;
      }
      const startedAt = Date.parse(state.startedAt);
      if (!Number.isFinite(startedAt)) {
        incrementReason(summary, "invalid_started_at");
        continue;
      }
      if (startedAt >= cutoff) {
        incrementReason(summary, "within_retention");
        continue;
      }
      if (validationLockBusy(runDir, summary)) continue;
      summary.eligible += 1;
      if (!dryRun) {
        try {
          fs.rmSync(runDir, { recursive: true });
          summary.deleted += 1;
        } catch (error) {
          summary.errors += 1;
        }
      }
    }
  }

  return summary;
}

module.exports = { pruneRunArtifacts };
