const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(["running", "ai_complete"]);
const TERMINAL_STATUSES = new Set(["complete", "validation_failed"]);
const LOCK_HANDSHAKE_TIMEOUT_MS = 5 * 1000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY
  | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW;
const LOCK_OPEN_FLAGS = fs.constants.O_RDWR
  | fs.constants.O_APPEND
  | fs.constants.O_CREAT
  | fs.constants.O_NOFOLLOW;
const LOCK_FD_HELPER_SOURCE = `
set -u
status_file=$1
if flock -n 3; then
  release_status() {
    flock -u 3
    printf 'released\\n' >"$status_file"
  }
  trap release_status EXIT
  printf 'locked\\n' >"$status_file"
  read -r _ || true
  exit 0
fi
printf 'busy\\n' >"$status_file"
exit 75
`;

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

function waitForLockStatus(statusPath, acceptedStatuses) {
  const deadline = Date.now() + LOCK_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = fs.readFileSync(statusPath, "utf8").trim();
      if (acceptedStatuses.has(status)) return status;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 5);
  }
  return "timeout";
}

function acquirePruneLock(statusDirectory, lockDirectory, runName) {
  const statusName = `.prune-lock-status-${process.pid}-${crypto.randomUUID()}`;
  const statusPath = path.join(statusDirectory, statusName);
  const lockPath = path.join(statusDirectory, runName, ".validation.lock");
  let lockDescriptor;
  let expectedLockStats;
  try {
    lockDescriptor = fs.openSync(lockPath, LOCK_OPEN_FLAGS, 0o666);
    expectedLockStats = fs.fstatSync(lockDescriptor, { bigint: true });
    if (!expectedLockStats.isFile()) {
      fs.closeSync(lockDescriptor);
      return { status: "invalid_lock" };
    }
  } catch (error) {
    if (lockDescriptor !== undefined) fs.closeSync(lockDescriptor);
    return { status: error && error.code === "ELOOP" ? "invalid_lock" : "error" };
  }

  const holder = spawn(
    "bash",
    ["-c", LOCK_FD_HELPER_SOURCE, "prune-lock", statusName],
    {
      cwd: lockDirectory,
      stdio: ["pipe", "ignore", "ignore", lockDescriptor],
    }
  );
  holder.on("error", () => {});
  fs.closeSync(lockDescriptor);
  const status = waitForLockStatus(statusPath, new Set(["locked", "busy"]));

  if (status !== "locked") {
    if (holder.pid) holder.kill("SIGTERM");
    fs.rmSync(statusPath, { force: true });
    return { status };
  }

  let currentLockStats;
  try {
    currentLockStats = fs.lstatSync(lockPath, { bigint: true });
  } catch (error) {
    currentLockStats = null;
  }
  if (
    !currentLockStats
    || !currentLockStats.isFile()
    || !sameIdentity(currentLockStats, expectedLockStats)
  ) {
    if (holder.pid) holder.kill("SIGTERM");
    waitForLockStatus(statusPath, new Set(["released"]));
    fs.rmSync(statusPath, { force: true });
    return { status: "invalid_lock" };
  }

  let released = false;
  return {
    status,
    release() {
      if (released) return;
      released = true;
      if (holder.pid) holder.kill("SIGTERM");
      const releaseStatus = waitForLockStatus(statusPath, new Set(["released"]));
      fs.rmSync(statusPath, { force: true });
      if (releaseStatus !== "released") {
        throw new Error("failed to release prune validation lock");
      }
    },
  };
}

function sameIdentity(stats, expectedStats) {
  return stats.dev === expectedStats.dev && stats.ino === expectedStats.ino;
}

function restoreQuarantinedRun(runDir, quarantineDir) {
  if (!fs.existsSync(quarantineDir) || fs.existsSync(runDir)) return;
  fs.renameSync(quarantineDir, runDir);
}

function deleteRunWithLock({ dateDirectory, lockDirectory, runName, expectedStats }) {
  const lock = acquirePruneLock(dateDirectory, lockDirectory, runName);
  if (lock.status !== "locked") return { status: lock.status };

  const runDir = path.join(dateDirectory, runName);
  const quarantineDir = path.join(
    dateDirectory,
    `.prune-${runName}-${crypto.randomUUID()}`
  );
  let status = "error";
  let releaseError = false;
  let renamed = false;
  try {
    fs.renameSync(runDir, quarantineDir);
    renamed = true;
    const quarantinedStats = fs.lstatSync(quarantineDir, { bigint: true });
    if (!quarantinedStats.isDirectory() || !sameIdentity(quarantinedStats, expectedStats)) {
      restoreQuarantinedRun(runDir, quarantineDir);
      renamed = false;
      status = "identity_changed";
    } else {
      fs.rmSync(quarantineDir, { recursive: true });
      renamed = false;
      status = "deleted";
    }
  } catch (error) {
    if (renamed) {
      try {
        restoreQuarantinedRun(runDir, quarantineDir);
      } catch (restoreError) {
        // The caller reports the deletion error; remnants stay quarantined for recovery.
      }
    }
  } finally {
    try {
      lock.release();
    } catch (error) {
      releaseError = true;
    }
  }
  return { status, releaseError };
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
    let dateDescriptor;
    try {
      dateDescriptor = fs.openSync(realDateDir, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      incrementReason(summary, "unreadable_path");
      continue;
    }
    const anchoredDateDir = `/proc/self/fd/${dateDescriptor}`;
    const childAnchoredDateDir = `/proc/${process.pid}/fd/${dateDescriptor}`;
    try {
      for (const runEntry of readEntries(anchoredDateDir, summary)) {
        const runDir = path.join(anchoredDateDir, runEntry.name);
        summary.examined += 1;
        if (!UUID_RE.test(runEntry.name)) {
          incrementReason(summary, "invalid_run_id");
          continue;
        }
        if (!resolveRealDirectory(runDir, realDateDir, summary)) continue;
        let runStats;
        try {
          runStats = fs.statSync(runDir, { bigint: true });
        } catch (error) {
          incrementReason(summary, "unreadable_path");
          continue;
        }
        const state = readRunState(runDir, summary);
        if (!state) continue;
        if (state.schemaVersion !== 2) {
          incrementReason(summary, "invalid_schema");
          continue;
        }
        if (state.meetingDate !== dateEntry.name) {
          incrementReason(summary, "meeting_date_mismatch");
          continue;
        }
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
        if (dryRun) {
          if (validationLockBusy(runDir, summary)) continue;
          summary.eligible += 1;
          continue;
        }
        const deletion = deleteRunWithLock({
          dateDirectory: anchoredDateDir,
          lockDirectory: childAnchoredDateDir,
          runName: runEntry.name,
          expectedStats: runStats,
        });
        if (deletion.status === "busy") {
          incrementReason(summary, "locked");
          continue;
        }
        if (deletion.status === "invalid_lock") {
          incrementReason(summary, "invalid_lock");
          continue;
        }
        summary.eligible += 1;
        if (deletion.status === "deleted") {
          summary.deleted += 1;
        } else if (deletion.status === "identity_changed") {
          incrementReason(summary, "identity_changed");
          summary.errors += 1;
        } else {
          summary.errors += 1;
        }
        if (deletion.releaseError) summary.errors += 1;
      }
    } finally {
      fs.closeSync(dateDescriptor);
    }
  }

  return summary;
}

module.exports = { pruneRunArtifacts };
