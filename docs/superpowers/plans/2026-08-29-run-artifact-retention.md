# Run Artifact Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete schema v2 run artifacts older than 90 days through a safe dry-run/apply operation and invoke it non-blockingly before schema v2 generation.

**Architecture:** A focused `report-run-pruner` module inventories only strict date/UUID run directories, validates terminal ownership and age, probes the existing validation lock, and deletes eligible directories only in apply mode. Configuration and `index.js` expose the policy through `MODE=prune` and a non-blocking schema v2 generate hook.

**Tech Stack:** Node.js CommonJS, `node:test`, built-in `fs/path/child_process`, Linux `flock`

**Spec:** `docs/superpowers/specs/2026-08-29-run-artifact-retention-design.md`

## Global Constraints

- Default retention is exactly 90 days; no count or disk-size limit.
- Only direct `runs/YYYY-MM-DD/<UUID-v4>` real directories are candidates.
- Only `complete` and `validation_failed` states older than the cutoff are eligible.
- Malformed paths/state, symlinks, active states, and busy validation locks fail closed.
- `MODE=prune` defaults to dry-run; only `PRUNE_APPLY=1` deletes.
- Automatic cleanup errors never change schema v2 generate success.
- Add no dependencies and do not change external crontab files.
- Do not create a Git commit until the user explicitly requests one.

---

### Task 1: Core run pruner

**Files:**
- Create: `lib/report-run-pruner.js`
- Create: `lib/__tests__/report-run-pruner.test.js`

**Interfaces:**
- Consumes: `{ outputDir: string, retentionDays: positive integer, dryRun: boolean, now?: Date }`
- Produces: `pruneRunArtifacts(options) -> { examined: number, eligible: number, deleted: number, skipped: number, errors: number, skippedReasons: object }`

- [x] **Step 1: Write failing tests for age, terminal state, and dry-run/apply**

Create real temporary run directories with literal timestamps. Assert that a
new terminal run is skipped, an old `complete` run is reported but retained in
dry-run, and the same run is removed in apply mode:

```js
const summary = pruneRunArtifacts({
  outputDir: dir,
  retentionDays: 90,
  dryRun: false,
  now: new Date("2026-08-29T00:00:00.000Z"),
});
assert.strictEqual(summary.deleted, 1);
assert.strictEqual(fs.existsSync(oldRunDir), false);
```

- [x] **Step 2: Run the new test and verify RED**

Run: `node --test lib/__tests__/report-run-pruner.test.js`

Expected: FAIL because `../report-run-pruner` does not exist.

- [x] **Step 3: Implement strict inventory and terminal age eligibility**

Implement and export:

```js
function pruneRunArtifacts({ outputDir, retentionDays, dryRun, now = new Date() }) {
  // Return a zero summary when runs/ does not exist.
  // lstat direct date/UUID children, validate real parents and state ownership,
  // compare startedAt to the cutoff, then delete only eligible apply candidates.
}

module.exports = { pruneRunArtifacts };
```

Use strict date and UUID-v4 regular expressions matching `report-run.js`,
`lstatSync` before `realpathSync`, and `fs.rmSync(runDir, { recursive: true })`
only after every check succeeds.

- [x] **Step 4: Run the test and verify GREEN**

Run: `node --test lib/__tests__/report-run-pruner.test.js`

Expected: PASS for age, terminal state, dry-run, and apply behavior.

- [x] **Step 5: Add failing safety tests**

Add independent cases proving the production branches fail closed:

```js
assert.strictEqual(prune(...activeRun).deleted, 0);
assert.strictEqual(prune(...malformedState).skippedReasons.invalid_state, 1);
assert.strictEqual(prune(...attemptMismatch).skippedReasons.owner_mismatch, 1);
assert.strictEqual(prune(...symlinkRun).deleted, 0);
assert.strictEqual(prune(...heldValidationLock).skippedReasons.locked, 1);
```

Each assertion must also prove the candidate or symlink target still exists.
Add one apply-mode case where `fs.rmSync` throws for the exact candidate, assert
`errors === 1`, and restore the built-in method in `finally`.
Add a date-directory replacement race that proves the initially verified real
parent is reused and an outside symlink target is never deleted.

- [x] **Step 6: Run the safety tests and verify RED**

Run: `node --test lib/__tests__/report-run-pruner.test.js`

Expected: FAIL on the first unimplemented skip reason or lock check.

- [x] **Step 7: Implement minimal skip reasons and lock probe**

Probe an existing `.validation.lock` with synchronous non-blocking `flock`.
Do not invoke `flock` when the file does not exist, so dry-run creates nothing.
Treat a busy exit as `locked`; treat spawn errors as a recorded per-run error.

- [x] **Step 8: Run Task 1 tests and inspect the diff**

Run: `node --test lib/__tests__/report-run-pruner.test.js`

Run: `git diff --check`

Expected: all pruner tests pass and no whitespace errors are reported.

### Task 2: Retention configuration

**Files:**
- Modify: `lib/config.js`
- Modify: `lib/__tests__/config-read-json.test.js`

**Interfaces:**
- Produces: `config.env.runArtifactRetentionDays: number`
- Produces: `config.env.pruneApply: boolean`

- [x] **Step 1: Write failing configuration tests**

Use `withEnv` to isolate the new variables and assert observable config values:

```js
assert.strictEqual(loadConfig().env.runArtifactRetentionDays, 90);
assert.strictEqual(loadConfig().env.pruneApply, false);
```

Then assert `RUN_ARTIFACT_RETENTION_DAYS=30`, `PRUNE_APPLY=1`, and invalid `0`
produce `30`, `true`, and a positive-integer configuration error respectively.

- [x] **Step 2: Run config tests and verify RED**

Run: `node --test lib/__tests__/config-read-json.test.js`

Expected: FAIL because the new environment fields are undefined.

- [x] **Step 3: Add the two config fields**

Add to `env` in `loadConfig()`:

```js
runArtifactRetentionDays: resolvePositiveInteger(
  process.env.RUN_ARTIFACT_RETENTION_DAYS,
  defaults.runArtifactRetentionDays ?? 90,
  "RUN_ARTIFACT_RETENTION_DAYS"
),
pruneApply: process.env.PRUNE_APPLY === "1",
```

- [x] **Step 4: Run config tests and verify GREEN**

Run: `node --test lib/__tests__/config-read-json.test.js`

Expected: all config tests pass.

### Task 3: CLI mode and automatic generate integration

**Files:**
- Modify: `index.js`
- Modify: `lib/__tests__/index-modes.test.js`
- Modify: `lib/__tests__/report-generate-v2.test.js`

**Interfaces:**
- Produces: `runPrune(config, options?) -> summary`
- Consumes: `pruneRunArtifacts()` from Task 1

- [x] **Step 1: Write a failing explicit-mode subprocess test around real pruning**

Build an old run in a temporary output directory and spawn `node index.js` with
`MODE=prune` and that `OUTPUT_DIR`. Assert the default invocation exits 0 and
retains the run. Spawn again with `PRUNE_APPLY=1`, then assert exit 0 and that
the run is deleted. This exercises config, dispatch, and the real pruner without
collect, AI, or Redmine mocks.

- [x] **Step 2: Run the mode test and verify RED**

Run: `node --test lib/__tests__/index-modes.test.js`

Expected: FAIL because `MODE=prune` reaches the unknown-mode branch.

- [x] **Step 3: Implement `runPrune` and dispatch `MODE=prune` before meeting-date resolution**

Add:

```js
function runPrune(config, options = {}) {
  const summary = pruneRunArtifacts({
    outputDir: config.env.outputDir,
    retentionDays: config.env.runArtifactRetentionDays,
    dryRun: options.dryRun ?? !config.env.pruneApply,
    now: options.now,
  });
  printPruneSummary(summary, { dryRun: options.dryRun ?? !config.env.pruneApply });
  return summary;
}
```

In `main()`, log mode first and return `runPrune(config)` before calling
`resolveRunMeetingDate`. Set exit code 1 when explicit prune returns errors.
Update the unknown-mode message to include `prune`.

- [x] **Step 4: Run the mode test and verify GREEN**

Run: `node --test lib/__tests__/index-modes.test.js`

Expected: explicit dry-run/apply behavior passes without snapshot or Redmine.

- [x] **Step 5: Write a failing non-blocking schema v2 generate test**

Inject a pruner that throws into `runGenerateV2` and capture `console.warn`.
Use the existing fake AI/snapshot fixture, then assert generation still returns
its normal validation result and a retention warning was emitted. The injected
failure is the boundary under test; do not assert mock call counts.

- [x] **Step 6: Run the generate test and verify RED**

Run: `node --test lib/__tests__/report-generate-v2.test.js`

Expected: FAIL because `runGenerateV2` does not invoke the injected pruner.

- [x] **Step 7: Add the automatic pre-generate hook**

At the beginning of `runGenerateV2`, invoke
`dependencies.pruneRunArtifacts || pruneRunArtifacts` with apply mode. Print the
same summary on success. Catch and warn on thrown errors or `summary.errors > 0`,
then continue into the unchanged generation flow.

- [x] **Step 8: Run Task 3 tests and inspect the diff**

Run: `node --test lib/__tests__/index-modes.test.js lib/__tests__/report-generate-v2.test.js`

Run: `git diff --check`

Expected: mode and schema v2 integration tests pass with no whitespace errors.

### Task 4: Operator documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-29-run-artifact-retention.md`

**Interfaces:**
- Documents: `RUN_ARTIFACT_RETENTION_DAYS`, `PRUNE_APPLY`, `MODE=prune`

- [x] **Step 1: Document the operator commands and automatic boundary**

Add these runnable examples and explain that schema v2 generate applies cleanup
non-blockingly:

```bash
MODE=prune ./run-report-env.sh
MODE=prune PRUNE_APPLY=1 ./run-report-env.sh
```

- [x] **Step 2: Run targeted tests**

Run: `node --test lib/__tests__/report-run-pruner.test.js lib/__tests__/config-read-json.test.js lib/__tests__/index-modes.test.js lib/__tests__/report-generate-v2.test.js`

Expected: all targeted tests pass.

- [x] **Step 3: Run the complete test suite**

Run: `node --test --test-reporter=dot lib/__tests__/*.test.js`

Expected: exit 0 with no test failures.

- [x] **Step 4: Run final repository checks**

Run: `git diff --check`

Run: `git status --short`

Expected: only Issue #29 design, plan, implementation, tests, and README changes
are present; no generated `out/` artifacts or unrelated files are tracked.
