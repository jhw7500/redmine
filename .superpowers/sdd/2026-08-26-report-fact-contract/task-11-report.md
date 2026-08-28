# Task 11 report — signed hexadecimal and lexical subject safety

## Status

DONE

Implementation commit: `036bc673346e4120dcb6c9f73e7a08749dd42480`

## Confirmed root causes and minimal design

### Signed hexadecimal ownership

The schema-v2 hexadecimal candidate began at `0x`, so a unary sign remained
outside its protected span. Numeric-only input such as `-0x10` also matched the
dimension grammar over the longer full span and was therefore selected as Q.

The hexadecimal pattern now owns an optional adjacent `+` or `-`. For
`-0x10`, hexadecimal and dimension candidates consequently have the same span,
and the existing deterministic priority (`hexadecimal: 3`, `dimension: 5`)
selects hexadecimal as V. No priority values or other candidate grammars were
changed. Exact signed surfaces validate, while dropped/flipped signs produce
`fact_value_mismatch` and a sign added outside an unsigned marker produces
`unmarked_protected_fact`; both codes are already non-overridable at the
schema-v2 publication gate.

### Lexical subject identity

Schema-v2 occurrence extraction and comparison both reused a broad Korean
trailing-particle heuristic. Because `도` can be either a particle or part of a
lexical noun, it reduced `신뢰도` to `신뢰` in both preceding metric labels and
same-line following counted targets.

Schema-v2 now preserves the extracted Korean subject verbatim after its
existing structural whitespace/punctuation boundaries. Comparison retains
only the explicit metric count-label suffix normalization for whitespace-
separated `수`, `개수`, and `건수`. The legacy schema-v1 `nounKey()` path is
unchanged, so this safety change does not alter legacy validation behavior.

## RED evidence

Both failures were observed before their corresponding production edits.

1. Signed hexadecimal:
   `rtk node --test --test-name-pattern="signed hexadecimal|hexadecimal signs" lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
   — exit 1; 0 passed, 2 failed. `-0x10` was catalogued as Q
   `measured_quantity`, `+0xFF` was catalogued as unsigned `0xFF`, and the exact
   `-0xFF` marker validated as FAIL against the truncated catalog surface.
2. Lexical subjects:
   `rtk node --test --test-name-pattern="lexical Korean" lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
   — exit 1; 0 passed, 2 failed. The catalog stored `신뢰` instead of `신뢰도`,
   and a preceding-label rewrite from `신뢰도` to `신뢰` incorrectly returned
   PASS (the same shared normalization covered the following-target shape).

## Files changed

- `lib/fact-occurrences.js`
- `lib/fact-validator.js`
- `lib/__tests__/fact-catalog.test.js`
- `lib/__tests__/fact-contract-validator.test.js`

## GREEN verification

- Signed-hex focused GREEN:
  `rtk node --test --test-name-pattern="signed hexadecimal|hexadecimal signs" lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
  — 2 passed, 0 failed.
- Lexical-subject focused GREEN:
  `rtk node --test --test-name-pattern="lexical Korean" lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
  — 2 passed, 0 failed.
- Combined new behavior:
  `rtk node --test --test-name-pattern="signed hexadecimal|hexadecimal signs|lexical Korean" lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
  — 4 passed, 0 failed, 0 cancelled, 0 skipped.
- Required focused catalog/contract suite:
  `rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-contract-validator.test.js`
  — 23 passed, 0 failed, 0 cancelled, 0 skipped.
- Required legacy suite:
  `rtk node --test lib/__tests__/fact-validator.test.js`
  — 16 passed, 0 failed, 0 cancelled, 0 skipped.
- Authoritative hostile suite:
  `rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/annotated-draft.test.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/report-run.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js lib/__tests__/report-update-v2.test.js`
  — 85 passed, 0 failed, 0 cancelled, 0 skipped.
- Full suite:
  `rtk node --test lib/__tests__/*.test.js`
  — 193 passed, 0 failed, 0 cancelled, 0 skipped.
- Syntax and whitespace:
  `rtk node --check lib/fact-occurrences.js`,
  `rtk node --check lib/fact-validator.js`, and `rtk git diff --check`
  — all exited 0.

No external service was called; hostile-suite AI and Redmine behavior used
repository-local fakes.

## Self-review

- Confirmed numeric-only `-0x10` and A–F `+0xFF` are each one V fact with the
  sign inside the protected surface, while unsigned hex remains unchanged.
- Confirmed exact signed markers pass and dropped, flipped, or externally added
  signs fail with non-overridable schema-v2 fact codes.
- Confirmed candidate priority, ordinary and signed decimal dimensions,
  versions, ISO dates, ratios, percentages, units, and bare numbers remain
  covered by green catalog/hostile regressions.
- Confirmed `신뢰도` remains distinct from `신뢰` for both preceding-label and
  following-target shapes, while exact forms pass.
- Confirmed exact `방안`, `방안 수`, English labels, and subjectless Q facts
  remain green in the focused contract suite.
- Confirmed the schema-v1 broad particle normalization remains isolated and its
  complete legacy test file is green.
- Scope contains only the two requested fixes and their regressions.

Concerns: none beyond the intentional fail-closed tradeoff: a grammatically
equivalent schema-v2 rewrite that changes an ambiguous attached particle now
requires manual draft editing.
