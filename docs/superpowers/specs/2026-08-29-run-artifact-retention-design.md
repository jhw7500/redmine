# Run Artifact Retention Design

**Date:** 2026-08-29
**Issue:** https://github.com/jhw7500/redmine/issues/29
**Status:** Implemented and verified

## 1. Context

Schema v2 generate stores immutable recovery and validation evidence under
`out/runs/YYYY-MM-DD/<run-id>/`. This made a failed AI draft recoverable without
another model call, but every attempt remains on disk indefinitely. Issue #25
intentionally deferred automatic cleanup so that recovery correctness could be
completed first.

The retention feature must bound old run artifacts without weakening the
existing publication, ownership, or validation guarantees.

## 2. Goals

- Remove terminal run artifacts older than 90 days.
- Run cleanup automatically before a schema v2 generate creates a new run.
- Provide an operator mode that previews the same cleanup decision before
  applying it.
- Never delete a run whose path, ownership, state, or lock safety cannot be
  established.
- Keep cleanup failure outside the generate success boundary.

## 3. Non-goals

- A maximum run count or disk-size quota.
- Compression, upload, backup, or archival storage.
- Retention for snapshots, canonical depth reports, validation sidecars, or
  published reports outside `out/runs/`.
- Changes to fact validation, run state transitions, or failed-draft recovery.
- A new scheduler or changes to the external crontab.

## 4. Configuration and modes

`RUN_ARTIFACT_RETENTION_DAYS` is a positive integer and defaults to `90`.
Invalid values fail configuration loading in the same way as the existing
positive integer settings.

`MODE=prune` runs retention without collect, AI, or Redmine access. It is a
dry-run by default. `PRUNE_APPLY=1` enables deletion for this explicit mode.

Schema v2 `generate` invokes the same retention function with deletion enabled
before it creates the new run directory. Schema v1 generate does not create run
artifacts and does not invoke retention.

## 5. Component boundary

Add `lib/report-run-pruner.js` with one public operation:

```js
pruneRunArtifacts({ outputDir, retentionDays, dryRun, now })
```

The operation returns a summary containing `examined`, `eligible`, `deleted`,
`skipped`, and `errors` as numeric counts, plus reason counts for skipped
entries. `now` defaults to the current time and is injectable for deterministic
tests.

The module owns inventory, eligibility, safety checks, and deletion. `index.js`
only selects dry-run versus apply, prints the summary, and decides whether an
error is fatal for the current mode.

## 6. Eligibility

The pruner examines only direct children matching both levels below:

```text
<outputDir>/runs/YYYY-MM-DD/<UUID-v4>
```

A run is eligible only when all of these conditions hold:

1. The date directory and run entry are real directories, not symbolic links.
2. Their resolved parents remain exactly inside the resolved `runs` root and
   date directory.
3. `state.json` is readable JSON.
4. `state.schemaVersion` is exactly `2` and `state.meetingDate` exactly matches
   the date directory.
5. `state.attemptId` exactly matches the directory UUID.
6. `state.startedAt` is a valid timestamp earlier than
   `now - retentionDays`.
7. `state.status` is `complete` or `validation_failed`.
8. The run validation lock can be acquired non-blockingly.

`running` and `ai_complete` are active states and are always skipped. A
`validation_failed` run remains recoverable during the 90-day window and
becomes eligible after it expires.

An active run state or held validation lock is a current reference and protects
the run. A historical terminal `.generation.json` sidecar is not a permanent
retention pin. After its run expires, revalidation or update of that old report
fails closed until the report is generated again. Treating every historical
sidecar as a pin would retain at least one run per report forever and defeat the
90-day policy.

The documented cron wrapper's `report-run.lock` remains the outer operational
serialization boundary. Dry-run only probes an existing validation lock and
does not create a lock file. Apply acquires the validation lock and holds it
through deletion. It pins the verified date directory with a file descriptor,
atomically renames the run to an unpredictable quarantine name, verifies the
quarantined directory's device and inode, and only then recursively deletes it.
This prevents a replaced parent path from redirecting deletion outside `runs`.

## 7. Fail-closed rules

The pruner skips rather than repairs or guesses when it encounters:

- a malformed date or UUID name;
- a symbolic link at either directory level;
- a real path outside the expected parent;
- missing, unreadable, or malformed `state.json`;
- a non-v2 schema or meeting-date ownership mismatch;
- an attempt ID mismatch;
- a missing or invalid `startedAt`;
- an unknown or active status;
- a busy validation lock;
- a run identity change during quarantine.

Dry-run and apply use the same inventory and eligibility function. Dry-run does
not delete directories or create lock files.

An individual deletion failure increments `errors` and processing may continue
for other already-validated candidates. `MODE=prune` reports a failure exit when
`errors > 0`. Automatic generate cleanup catches the same condition, prints a
warning summary, and continues into generation.

## 8. Output

Both explicit and automatic execution print one compact summary with mode,
retention days, and the five counts. Skipped reason counts are printed only
when non-empty. Paths are not printed in the default summary.

This is operational accounting, not a persistent manifest. Existing immutable
run artifacts remain the source of truth until they are deleted.

## 9. Integration flow

For schema v2 generate:

1. Load configuration.
2. Invoke apply-mode retention for `outputDir`.
3. Warn and continue if retention reports errors or throws.
4. Load the sealed snapshot.
5. Create and execute the new schema v2 run using the existing flow.

For explicit prune:

1. Load configuration.
2. Invoke retention with `dryRun = !PRUNE_APPLY`.
3. Print the summary.
4. Exit successfully when there are no deletion errors; otherwise fail without
   invoking collect, AI, validation, or Redmine.

## 10. Tests

Use real temporary directories and the existing Node test runner.

- A terminal run newer than 90 days is retained.
- A `complete` run older than 90 days is deleted in apply mode.
- A `validation_failed` run older than 90 days is deleted in apply mode.
- Dry-run reports an old eligible run without deleting it.
- Active statuses and a held validation lock are skipped.
- Malformed dates, UUIDs, state, ownership mismatches, and symbolic links are
  skipped without deleting their targets.
- A deletion error is returned in the summary.
- Config tests cover the default, override, and invalid retention values.
- Mode tests prove explicit prune does not call collect, AI, or Redmine and
  schema v2 generate continues after an injected cleanup failure.

## 11. Documentation

README documents the two settings, dry-run/apply examples, automatic schema v2
generate behavior, the 90-day default, and the non-blocking generate boundary.
