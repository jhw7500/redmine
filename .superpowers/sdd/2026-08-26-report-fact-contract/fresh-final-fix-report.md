# Fresh final-review fix report

- Date: 2026-08-27
- Branch: `feat/report-fact-contract`
- Reviewed base: `4a6c3e6`
- Implementation commit: `d44b0f6`
- Scope: the one Critical and two Important findings in `fresh-final-fix-brief.md`

## Outcome

All three findings are fixed as one implementation wave. Signed numeric surfaces are maximal,
every deterministic Q subject is checked fail-closed, and validation publication plus its final
promotion/failure update is serialized per run. No dependency, network call, external service,
push, merge, or publish operation was introduced.

## Root causes and design decisions

### 1. Numeric signs were outside protected spans

The schema-v2 occurrence patterns began at `\d` behind an ASCII word boundary, so a unary `+`
or `-` was not included in a catalog or output-scanner span. The catalog therefore stored `5 ms`
for source `-5 ms`, and a marker containing only `5 ms` looked exact.

The occurrence patterns now include an optional unary sign at the numeric boundary for bare and
decimal values, percentages, dimensions, supported units, ratios, and explicit counted forms.
Both dimension and ratio operands accept their own sign. ISO dates, hexadecimal values, test
results, and their priority/leftmost-longest selection remain separate; the full date candidate
still wins over internal numeric candidates. Signed explicit counters retain their
`counted_quantity` type and subject.

### 2. Q-subject validation failed open

`validateClaim()` returned immediately for every Q fact except `counted_quantity`, and even the
counted path did nothing when no following counted occurrence enclosed the marker. A Q fact with
a preceding metric label could therefore be rebound to an unrelated preceding label or following
Korean target.

Validation now checks every catalog Q fact that has a non-empty subject. It derives deterministic
output context from the enclosing Q occurrence: a same-line following counted target takes
precedence, otherwise the preceding metric label is used. Korean count-label suffixes such as
`수`, `개수`, and `건수` plus trailing particles are normalized for comparison. Missing or
different output context emits `fact_subject_mismatch`; a catalog Q with no deterministic subject
remains subjectless and is not assigned one.

### 3. A stale validation revision could promote

`appendValidationRevision()` and `promoteRunReport()` were independent operations. Promotion
checked attempt ownership and status but did not prove that the supplied validation was the
run state's exact latest revision/path/hash. Revision N could therefore promote after the same
attempt published N+1.

A per-run `.validation.lock` now serializes append and final promotion/failure-state updates.
`appendValidationRevision()` and `promoteRunReport()` acquire it themselves, while generate and
revalidate hold it across the complete append-to-finalize transaction. In-process nesting is
re-entrant so the outer transaction does not self-deadlock.

Promotion, while holding the run lock, acquires the generation-state lock and then proves all of
the following before mutating `report.clean.md`, the canonical report, generation state, or run
completion state:

- validation attempt ownership and positive integer revision;
- exact latest run-state revision and derived immutable filename;
- identical revision/path/hash evidence in the proposed generation state;
- hash equality between the supplied validation and the immutable validation artifact.

The sole lock order is **run-validation lock → generation-state lock**. The audited generation-lock
entry points only update generation state and never acquire a run lock, so no reverse acquisition
path exists. Promotion rollback now restores the prior run-clean report as well as the canonical,
generation, and run-state artifacts covered by the prior transaction behavior.

## Per-finding RED → GREEN evidence

### Finding 1

Test-only changes were made first in `fact-catalog.test.js` and
`fact-contract-validator.test.js`.

RED command:

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js
```

Observed RED: 16 passed, 2 failed. The catalog returned signless/split surfaces (`5`, `2.5`,
`62.5%`, `1080`, and others) instead of the signed maximal literals. The validator reported
`PASS` where the regression expected `FAIL` for source `-5 ms` rewritten as marker surface
`5 ms`. This directly reproduced the sign-drop publication defect before production edits.

GREEN with the same command: 18 passed, 0 failed.

### Finding 2

The subject test was added before changing `validateClaim()`.

RED command:

```bash
rtk node --test lib/__tests__/fact-contract-validator.test.js
```

Observed RED: 12 passed, 1 failed. `3 방안 적용` rewritten as
`캠페인 수: [[fact:Q0001|3]].` returned `PASS` where `FAIL` was required. The same regression also
covers `queue depth 4096` rebound to a following `캠페인`, exact same-subject label/following forms,
missing output context, and a genuinely subjectless catalog Q.

GREEN in the combined fact-focused command: 19 passed, 0 failed.

### Finding 3

The competing same-attempt test published N, then N+1, then attempted to promote N while
snapshotting the prior canonical, run-clean, global state, and N+1 run-state evidence.

RED command:

```bash
rtk node --test lib/__tests__/report-run.test.js
```

Observed RED: 21 passed, 1 failed with `Missing expected exception`; stale N promoted instead of
being rejected. This proved the exact stale-completion defect before the lock/check production
changes.

GREEN with the same command: 22 passed, 0 failed. Generate/revalidate focused paths then passed
12/12, including zero-LLM recovery and promotion rollback.

## Changed files

- `lib/fact-occurrences.js` — signed maximal schema-v2 occurrence patterns.
- `lib/fact-validator.js` — signed dimension normalization and deterministic Q-subject checking.
- `lib/report-run.js` — per-run validation lock, exact latest validation proof, and run-clean rollback.
- `index.js` — generate/revalidate append-to-finalize transactions under the run lock.
- `lib/__tests__/fact-catalog.test.js` — signed form, priority, and signed-counter regressions.
- `lib/__tests__/fact-contract-validator.test.js` — sign mutation and Q-subject regressions.
- `lib/__tests__/report-run.test.js` — stale same-attempt rejection and exact-evidence fixtures.
- `.superpowers/sdd/2026-08-26-report-fact-contract/fresh-final-fix-report.md` — this report.

## Final verification

Focused five-file suite:

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/report-run.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js
```

Result: 53 passed, 0 failed.

Authoritative seven-file hostile suite:

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/annotated-draft.test.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/report-run.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js lib/__tests__/report-update-v2.test.js
```

Result: 81 passed, 0 failed.

Full suite:

```bash
rtk node --test lib/__tests__/*.test.js
```

Result: 189 passed, 0 failed.

Syntax checks passed for every modified production file:

```bash
rtk node --check index.js
rtk node --check lib/fact-occurrences.js
rtk node --check lib/fact-validator.js
rtk node --check lib/report-run.js
```

`rtk git diff --check` also exited 0.

## Self-review

- Rechecked each acceptance statement against a behavior test and its guarding production path.
- Mentally mutated sign inclusion, subject type gating, absent subject handling, latest revision,
  latest path, latest hash, artifact hash, and both lock acquisitions; the focused tests fail for
  each relevant mutation.
- Audited all lock call sites and found no generation-state-lock → run-validation-lock path.
- Confirmed stale rejection happens before report or state mutation and retains N+1 evidence.
- Confirmed immutable revisions, explicit counter semantics, Task 10 same-line behavior,
  generate/revalidate success, zero-LLM revalidation, and rollback tests remain green.
- Reviewed the staged implementation diff for unrelated changes; none were included.

## Concerns

No correctness concern remains within the accepted scope. The new run lock intentionally follows
the existing fail-fast filesystem-lock convention; as with the existing generation-state lock, a
hard process termination may require removing an abandoned lock file before retrying.

This report is recorded in a follow-up documentation commit so it can contain the immutable
implementation commit hash above.
