# Report Source Coverage Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an AI-generated weekly report from becoming publishable when required sections or Notion items are omitted, or when source-bound facts move to another canonical category.

**Architecture:** Add a deterministic source-coverage catalog beside the existing fact catalog. Bare `[[source:C....]]` and `[[source:N....]]` markers bind required section headings and Notion items to canonical paths; a combined schema-v2 contract validator strips and validates source markers before running the existing fact validator. New runs pin the coverage artifact and hash through generate, revalidate, and update while old fact-only schema-v2 runs remain readable.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, `node:assert`, existing atomic JSON/text artifact helpers, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-report-source-coverage-contract-design.md`

## Global Constraints

- Prefix every shell command with `rtk` per `/home/jhw/.codex/RTK.md`.
- Use `apply_patch` for source and test edits.
- Follow strict TDD: write one behavioral test, run it and observe the expected failure, then write the minimum production code.
- Do not weaken protected number, PASS/FAIL, unit, counter, open-status, pickaxe, hash, or publication validation.
- Generate may call Claude at most once; validation and revalidation must never trigger another model call.
- A failed validation must make zero Redmine requests and must not replace the canonical report.
- Do not call real Claude, Notion, Redmine, or other network services in tests.
- Preserve coverage-free schema-v2 run compatibility.
- Do not commit, push, create a PR, run a real Claude pilot, or publish to Redmine without a separate explicit user instruction.

## File Map

- Create `lib/source-coverage.js`: catalog construction, canonical path resolution, source marker annotation/parsing/validation.
- Create `lib/report-contract.js`: compose source-coverage and fact validation into one schema-v2 validation result.
- Create `lib/__tests__/source-coverage.test.js`: pure catalog, marker, path, and 2026-08-26 regression tests.
- Create `lib/__tests__/report-contract.test.js`: combined coverage/fact validation behavior.
- Create `lib/__tests__/fixtures/report-source-coverage-incident.json`: minimal `iMX8MP`/`iMX93` incident fixture.
- Modify `lib/fact-catalog.js`: attach `sourceSectionPath` when known paths are supplied.
- Modify `lib/fact-references.js`: restrict identifier recovery to the output canonical path.
- Modify `lib/fact-validator.js`: reject full fact markers used outside their source canonical path.
- Modify `lib/publisher.js`: add source-marker prompt guidance.
- Modify `lib/report-run.js`: persist, load, and verify `source-coverage.json` ownership.
- Modify `index.js`: wire coverage through generate, revalidate, promotion, and update evidence.
- Modify `lib/__tests__/helpers/report-run-fixture.js`: allow structured categories/autoContent and coverage-aware fake outputs.
- Modify existing schema-v2 generate/revalidate/update/prompt/run tests for the new optional ownership fields.
- Modify `README.md` and the approved design status only after behavior is green.

---

### Task 1: Deterministic source-coverage catalog and validator

**Files:**
- Create: `lib/source-coverage.js`
- Create: `lib/__tests__/source-coverage.test.js`
- Create: `lib/__tests__/fixtures/report-source-coverage-incident.json`

**Interfaces:**
- Produces: `buildSourceCoverageCatalog(snapshot, categories) -> catalog`
- Produces: `annotateSourceCoverageReferences(content, catalog) -> string`
- Produces: `validateSourceCoverage(annotatedContent, catalog) -> { cleanContent, issues, coverage }`
- Produces: `sourceSectionPathAt(content, offset, knownPaths) -> string[] | null`
- Catalog shape: `{ schemaVersion: 1, sections, items, knownPaths, coverageCatalogHash }`

- [ ] **Step 1: Add the minimal incident fixture**

Create a literal fixture containing both similarly named BSP sections and three Notion items:

```json
{
  "categories": {
    "pimBsp": {"label":"iMX8MP BSP","parent":"PIM","templateKey":"PIM_BSP_KO"},
    "wlanBsp": {"label":"iMX93 BSP","parent":"Wireless Lan","templateKey":"WLAN_BSP_KO"},
    "etc": {"label":null,"parent":"ETC","templateKey":"ETC_KO"}
  },
  "autoContent": {
    "{{PIM_BSP_KO}}":"    - [Notion] IIM-42652 내장 IMU 드라이버 브링업\n    - [Notion] Sterling60 규제 DB 복구",
    "{{WLAN_BSP_KO}}":"    - [Notion] wlan-package 다보드 부팅 SSoT",
    "{{ETC_KO}}":"  - (변경 없음)"
  },
  "rawContent":"#### <span style=\"color:blue\">조현우</span>\n\n- PIM\n  - iMX8MP BSP\n    - [Notion] IIM-42652 내장 IMU 드라이버 브링업\n    - [Notion] Sterling60 규제 DB 복구\n\n- Wireless Lan\n  - iMX93 BSP\n    - [Notion] wlan-package 다보드 부팅 SSoT\n\n- ETC\n  - (변경 없음)\n"
}
```

- [ ] **Step 2: Write failing catalog and annotation tests**

Add tests with hand-derived expectations:

```js
test("coverage catalog requires populated configured sections and every Notion item", () => {
  const catalog = buildSourceCoverageCatalog(snapshot, fixture.categories);
  assert.deepStrictEqual(
    catalog.sections.map(({ id, requiredPath }) => [id, requiredPath]),
    [
      ["C0001", ["PIM", "iMX8MP BSP"]],
      ["C0002", ["Wireless Lan", "iMX93 BSP"]],
    ]
  );
  assert.deepStrictEqual(
    catalog.items.map(({ id, requiredPath }) => [id, requiredPath]),
    [
      ["N0001", ["PIM", "iMX8MP BSP"]],
      ["N0002", ["PIM", "iMX8MP BSP"]],
      ["N0003", ["Wireless Lan", "iMX93 BSP"]],
    ]
  );
});

test("coverage annotation appends bare markers without changing line count", () => {
  const annotated = annotateSourceCoverageReferences(fixture.rawContent, catalog);
  assert.match(annotated, /iMX8MP BSP \[\[source:C0001\]\]/);
  assert.match(annotated, /IIM-42652.*\[\[source:N0001\]\]/);
  assert.strictEqual(annotated.split("\n").length, fixture.rawContent.split("\n").length);
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
rtk node --test lib/__tests__/source-coverage.test.js
```

Expected: FAIL because `../source-coverage` does not exist.

- [ ] **Step 4: Implement catalog construction and annotation minimally**

Implement these rules in `lib/source-coverage.js`:

```js
function buildSourceCoverageCatalog(snapshot, categories) {
  const sections = populatedCategories(snapshot.autoContent, categories);
  const knownPaths = uniquePaths(sections.map((entry) => entry.requiredPath));
  const items = notionEntries(snapshot.rawContent, knownPaths);
  const payload = { schemaVersion: 1, sections, items, knownPaths };
  return { ...payload, coverageCatalogHash: hashObject(payload) };
}

function annotateSourceCoverageReferences(content, catalog) {
  const markersByLine = indexMarkersBySourceLine(catalog);
  return String(content).split("\n").map((line, index) => {
    const markers = markersByLine.get(index + 1) || [];
    return markers.length ? `${line} ${markers.join(" ")}` : line;
  }).join("\n");
}
```

Derive `requiredPath` only from `categories`; do not infer a replacement category from item text. Treat an `autoContent` value as empty when its nonblank bullets contain only `(변경 없음)`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same focused command. Expected: all catalog/annotation tests PASS.

- [ ] **Step 6: Write failing validation tests**

Add independent tests that prove the break:

```js
test("coverage validation rejects missing, duplicate, unknown, and misplaced markers together", () => {
  const output = [
    header,
    "- PIM",
    "  - iMX93 BSP [[source:C0001]]",
    "    - IMU [[source:N0001]] [[source:N0001]] [[source:N9999]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "",
  ].join("\n");
  const result = validateSourceCoverage(output, catalog);
  assert.deepStrictEqual(new Set(result.issues.map((issue) => issue.code)), new Set([
    "source_section_heading_mismatch",
    "source_section_mismatch",
    "duplicate_source_id",
    "unknown_source_id",
    "missing_source_id",
  ]));
});

test("ETC markers may be grouped below Personal AI themes", () => {
  assert.deepStrictEqual(validateSourceCoverage(validEtcOutput, etcCatalog).issues, []);
});
```

- [ ] **Step 7: Run validation tests and verify RED**

Expected: FAIL because marker parsing/path validation is not implemented.

- [ ] **Step 8: Implement marker parsing, canonical path resolution, and clean rendering**

Use exact bare syntax `[[source:C0001]]` and `[[source:N0001]]`. Collect all valid occurrences, scan malformed `[[source:` fragments, locate each occurrence, and then:

- require every catalog ID exactly once;
- reject unknown and duplicate IDs;
- require a `C` marker on the exact configured heading line;
- require an `N` marker under its `requiredPath`;
- allow deeper theme indentation when the required path is only `["ETC"]`;
- remove source markers only, leaving fact markers untouched.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```bash
rtk node --test lib/__tests__/source-coverage.test.js
```

Expected: all source-coverage tests PASS with no warnings.

- [ ] **Step 10: Record a commit checkpoint without committing**

Inspect `rtk git diff --check` and `rtk git status --short`. Do not run `git commit` until the user explicitly asks.

---

### Task 2: Bind fact identifiers to canonical source sections

**Files:**
- Modify: `lib/fact-catalog.js`
- Modify: `lib/fact-references.js`
- Modify: `lib/fact-validator.js`
- Modify: `lib/__tests__/fact-catalog.test.js`
- Modify: `lib/__tests__/fact-references.test.js`
- Modify: `lib/__tests__/fact-contract-validator.test.js`

**Interfaces:**
- Extend: `buildFactCatalog(rawContent, systemFacts = [], options = {})`
- `options.knownPaths` enables `sourceSectionPath` on source facts.
- Extend: `restoreUnmarkedIdentifierReferences(content, catalog, options = {})`
- `options.knownPaths` restricts recovery candidates to the output path.
- Extend validator options with `knownPaths` and add `fact_section_mismatch`.

- [ ] **Step 1: Write a failing fact-catalog path test**

```js
test("fact catalog records the canonical section owning each source fact", () => {
  const raw = `${header}\n- PIM\n  - iMX8MP BSP\n    - IIM-42652\n- Wireless Lan\n  - iMX93 BSP\n    - wlan-package\n`;
  const knownPaths = [["PIM", "iMX8MP BSP"], ["Wireless Lan", "iMX93 BSP"]];
  const catalog = buildFactCatalog(raw, [], { knownPaths });
  assert.deepStrictEqual(
    catalog.facts.filter((fact) => ["iMX8MP", "iMX93"].includes(fact.raw))
      .map(({ raw: surface, sourceSectionPath }) => [surface, sourceSectionPath]),
    [
      ["iMX8MP", ["PIM", "iMX8MP BSP"]],
      ["iMX93", ["Wireless Lan", "iMX93 BSP"]],
    ]
  );
});
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run the named test file. Expected: FAIL because `sourceSectionPath` is absent.

- [ ] **Step 3: Add source paths before final catalog hashing**

Use `sourceSectionPathAt(normalizedRawContent, occurrence.start, options.knownPaths)` while building each source fact. Keep system facts at `sourceSectionPath: null` or omit the field consistently. The existing `finalizeCatalog()` hash must include the new field.

- [ ] **Step 4: Run the catalog test and verify GREEN**

Expected: the new test and all existing fact-catalog tests PASS.

- [ ] **Step 5: Write the failing cross-section recovery test**

```js
test("identifier recovery never binds the Wireless iMX93 fact inside PIM", () => {
  const restored = restoreUnmarkedIdentifierReferences(
    `${header}\n- PIM\n  - iMX93 BSP\n`,
    catalog,
    { knownPaths }
  );
  assert.strictEqual(restored.includes("[[fact:"), false);
});
```

- [ ] **Step 6: Run the reference test and verify RED**

Expected: FAIL because current recovery selects `iMX93` from another section.

- [ ] **Step 7: Filter recovery candidates by output path**

For each unmarked identifier occurrence, compute its output path. When `knownPaths` are supplied, retain only candidates whose `fact.sourceSectionPath` exactly equals that output path before applying the existing context-token ranking. Preserve current behavior when no paths are supplied for compatibility tests.

- [ ] **Step 8: Run the reference test and verify GREEN**

Expected: all fact-reference tests PASS.

- [ ] **Step 9: Write a failing explicit-marker section test**

```js
test("schema v2 rejects a full fact marker used outside its source section", () => {
  const output = `${header}\n- PIM\n  - iMX93 BSP [[fact:${wlanFact.id}|iMX93]]\n`;
  const result = validateAnnotatedReport(raw, output, catalog, {
    ...baseOptions(),
    knownPaths,
  });
  assert.ok(result.validation.issues.some((issue) =>
    issue.code === "fact_section_mismatch" && issue.factId === wlanFact.id
  ));
});
```

- [ ] **Step 10: Run the validator test and verify RED**

Expected: FAIL because `validateClaim()` currently checks section context only for counted quantities.

- [ ] **Step 11: Add section evidence to fact validation**

In `validateClaim()`, for a source-bound fact with `sourceSectionPath`, compute the claim output path and add `fact_section_mismatch` with expected/actual paths and source/output excerpts when they differ. Do not apply this check to system facts. Pass `options.knownPaths` from `validateAnnotatedReport()` into claim validation.

- [ ] **Step 12: Run all three focused fact suites**

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-references.test.js lib/__tests__/fact-contract-validator.test.js
```

Expected: all focused fact tests PASS.

- [ ] **Step 13: Record a commit checkpoint without committing**

Run `rtk git diff --check`; retain changes uncommitted.

---

### Task 3: Compose source and fact validation and update the AI prompt

**Files:**
- Create: `lib/report-contract.js`
- Create: `lib/__tests__/report-contract.test.js`
- Modify: `lib/publisher.js`
- Modify: `lib/__tests__/publisher-ai-budget.test.js`

**Interfaces:**
- Produces: `validateV2ReportContract(rawContent, annotatedContent, factCatalog, coverageCatalog, options) -> { cleanContent, validation }`
- Extend: `buildAiPrompt(..., { factCatalog, factInputMode, coverageCatalog, sourceCoverageMode })`
- Validation retains schema version 2 and adds `sourceCoverageMode`, `coverageCatalogHash`, and `sourceCoverage` counts.

- [ ] **Step 1: Write a failing combined-contract test**

```js
test("combined contract keeps working-draft hash while stripping source and fact markers", () => {
  const result = validateV2ReportContract(raw, workingDraft, factCatalog, coverageCatalog, options);
  assert.strictEqual(result.validation.annotatedDraftHash, sha256(workingDraft));
  assert.strictEqual(result.validation.coverageCatalogHash, coverageCatalog.coverageCatalogHash);
  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(result.cleanContent.includes("[[source:"), false);
  assert.strictEqual(result.cleanContent.includes("[[fact:"), false);
});

test("combined contract merges coverage and fact failures in one revision", () => {
  const result = validateV2ReportContract(raw, brokenDraft, factCatalog, coverageCatalog, options);
  assert.ok(result.validation.issues.some((issue) => issue.code === "missing_source_id"));
  assert.ok(result.validation.issues.some((issue) => issue.code === "fact_value_mismatch"));
  assert.strictEqual(result.validation.status, "FAIL");
});
```

- [ ] **Step 2: Run the combined-contract test and verify RED**

Expected: FAIL because `report-contract.js` does not exist.

- [ ] **Step 3: Implement the validation composition**

The function must:

1. run `validateSourceCoverage()` on the original working draft;
2. run `validateAnnotatedReport()` on the source-marker-clean annotated content;
3. combine both issue arrays and recompute `FAIL`/`WARNING`/`PASS`;
4. set `annotatedDraftHash` from the original working draft;
5. expose the fact validator's final clean report;
6. preserve existing open-issue checks and fact metadata.

When `coverageCatalog` is null, delegate to the existing fact-only behavior unchanged.

- [ ] **Step 4: Run the combined-contract test and verify GREEN**

Expected: all report-contract tests PASS.

- [ ] **Step 5: Write a failing prompt behavior test**

Exercise `buildAiPrompt()` and assert behavior, not source text placement:

```js
test("coverage prompt makes source markers mandatory while fact references stay optional", () => {
  const prompt = buildAiPrompt(annotatedSource, config, meetingDate, {
    factCatalog,
    factInputMode: "inline_refs",
    coverageCatalog,
    sourceCoverageMode: "required_sections_and_notion_v1",
  });
  assert.match(prompt, /\[\[source:C0001\]\]/);
  assert.match(prompt, /모든.*source.*marker.*보존/s);
  assert.match(prompt, /source coverage marker.*생략.*금지/s);
});
```

- [ ] **Step 6: Run the prompt test and verify RED**

Expected: FAIL because coverage guidance is absent.

- [ ] **Step 7: Add compact source-coverage guidance**

Add a prompt block that distinguishes optional fact references from mandatory source markers. Do not duplicate the coverage catalog: the markers are already inline in `rawContent`. Keep the existing 100,000-character input limit and one-call contract.

- [ ] **Step 8: Run prompt and combined-contract tests**

```bash
rtk node --test lib/__tests__/publisher-ai-budget.test.js lib/__tests__/report-contract.test.js
```

Expected: both suites PASS.

- [ ] **Step 9: Record a commit checkpoint without committing**

Run `rtk git diff --check`; retain changes uncommitted.

---

### Task 4: Persist and verify the coverage artifact in report runs

**Files:**
- Modify: `lib/report-run.js`
- Modify: `lib/__tests__/report-run.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`

**Interfaces:**
- Add `coverageCatalogPath` to `makeRunPaths()`.
- `loadResolvedReportRun()` returns `coverageCatalog` when `state.sourceCoverageMode` is present, otherwise `null`.
- Extend `assertRunInputs(state, snapshot, factCatalog, expected, coverageCatalog = null)`.

- [ ] **Step 1: Write failing run path and ownership tests**

```js
test("run paths include the immutable source coverage artifact", () => {
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  assert.strictEqual(paths.coverageCatalogPath, path.join(paths.runDir, "source-coverage.json"));
});

test("coverage-enabled run inputs require the exact catalog hash", () => {
  assert.doesNotThrow(() => assertRunInputs(state, snapshot, factCatalog, expected, coverageCatalog));
  assert.throws(
    () => assertRunInputs(state, snapshot, factCatalog, expected, changedCoverageCatalog),
    /coverage catalog hash/i
  );
});
```

Also keep an existing state with no `sourceCoverageMode` and assert that no coverage file is required.

- [ ] **Step 2: Run report-run tests and verify RED**

```bash
rtk node --test lib/__tests__/report-run.test.js
```

Expected: FAIL because coverage paths and ownership are absent.

- [ ] **Step 3: Extend run paths, loading, and hash verification minimally**

Recompute the stored coverage hash from exactly:

```js
hashObject({
  schemaVersion: coverageCatalog.schemaVersion,
  sections: coverageCatalog.sections,
  items: coverageCatalog.items,
  knownPaths: coverageCatalog.knownPaths,
});
```

If `state.sourceCoverageMode` is set, require the artifact, state hash, and intrinsic hash. If it is absent, return `coverageCatalog: null` without reading `source-coverage.json`.

- [ ] **Step 4: Run report-run tests and verify GREEN**

Expected: all report-run tests PASS.

- [ ] **Step 5: Extend the shared fixture with structured source data**

Change `setupSnapshot()` to accept optional `autoContent` and `categories`. Put categories on `fixture.config.categories`, and keep both defaults empty so unrelated existing tests remain coverage-empty.

- [ ] **Step 6: Run helper-consuming generate/revalidate/update tests**

```bash
rtk node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js lib/__tests__/report-update-v2.test.js
```

Expected at this checkpoint: existing tests PASS; no production generate wiring has changed yet.

- [ ] **Step 7: Record a commit checkpoint without committing**

Run `rtk git diff --check`; retain changes uncommitted.

---

### Task 5: Wire coverage through generate and revalidate

**Files:**
- Modify: `index.js`
- Modify: `lib/__tests__/report-generate-v2.test.js`
- Modify: `lib/__tests__/report-revalidate.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`

**Interfaces:**
- New runs set `sourceCoverageMode: "required_sections_and_notion_v1"`.
- Run/global state, prompt metadata, and validation pin `coverageCatalogHash`.
- `draft.working.annotated.md` retains source markers; `report.clean.md` and canonical report do not.

- [ ] **Step 1: Write the failing 2026 incident generate test**

Use the minimal fixture and a fake Claude output that omits all source markers and writes `PIM > iMX93 BSP`:

```js
test("generate keeps the canonical report when Claude omits source coverage and moves the BSP", async (t) => {
  const result = await runGenerate(config, meetingDate);
  assert.strictEqual(result.validation.publishable, false);
  assert.ok(result.validation.issues.some((issue) => issue.code === "missing_source_id"));
  assert.strictEqual(fs.readFileSync(callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(reportPath), false);
  assert.strictEqual(fs.existsSync(result.runPaths.coverageCatalogPath), true);
});
```

- [ ] **Step 2: Run the named generate test and verify RED**

Expected: FAIL because current generate has no source coverage contract and reports PASS.

- [ ] **Step 3: Build and persist catalogs before the AI call**

In `runGenerateV2()`:

- build the coverage catalog from the sealed snapshot and `config.categories`;
- build the fact catalog with `knownPaths`;
- apply fact annotation, then source annotation;
- initialize and immutably write both catalogs;
- pin `sourceCoverageMode` and `coverageCatalogHash` in run/global states;
- include both fields in `prompt-input.json` before hashing it.

If coverage catalog construction or source annotation fails, the Claude spawn marker must remain absent.

- [ ] **Step 4: Validate the complete working draft through `validateV2ReportContract()`**

Pass `knownPaths` into identifier recovery, then normalize open-status clauses without removing source markers. Store the working draft, call the combined contract validator, and promote only its clean content.

- [ ] **Step 5: Run the incident generate test and verify GREEN**

Expected: `validation_failed`, one fake Claude call, no canonical report.

- [ ] **Step 6: Write a passing generate test with all markers**

Make the fake Claude output preserve both `C` and `N` source references plus a valid fact reference. Assert:

- validation is publishable;
- working draft contains `[[source:`;
- clean/canonical reports contain neither source nor fact markers;
- run/global state and prompt metadata contain the same coverage hash.

- [ ] **Step 7: Run the passing test and verify RED, then GREEN**

First observe the expected missing-state/hash assertion failure, then add only the missing state/promotion fields and rerun until PASS.

- [ ] **Step 8: Write a revalidate recovery test**

Start from the failed incident run, edit only `draft.working.annotated.md` to restore content and the exact source markers, set `RUN_ID`, and assert:

- revalidate performs zero additional Claude calls;
- validation revision increments;
- final state becomes complete;
- canonical report is source-marker-free.

- [ ] **Step 9: Run revalidate test and verify RED**

Expected: FAIL because revalidate still calls the fact-only validator or does not load coverage ownership.

- [ ] **Step 10: Wire coverage-aware revalidation**

Load/verify the optional coverage catalog through `loadResolvedReportRun()` and `assertRunInputs()`. Use combined validation only when `sourceCoverageMode` is present; preserve the old fact-only call for historical schema-v2 runs.

- [ ] **Step 11: Run generate and revalidate suites**

```bash
rtk node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js
```

Expected: both suites PASS and fake Claude call counts match exactly.

- [ ] **Step 12: Record a commit checkpoint without committing**

Run `rtk git diff --check`; retain changes uncommitted.

---

### Task 6: Pin coverage evidence at update and keep historical compatibility

**Files:**
- Modify: `index.js`
- Modify: `lib/__tests__/report-update-v2.test.js`
- Modify: `lib/__tests__/index-modes.test.js`

**Interfaces:**
- Add non-overridable code `coverage_catalog_hash_mismatch`.
- `assertV2PublishEvidence()` verifies coverage state, artifact, validation, and global ownership only when coverage mode is active.

- [ ] **Step 1: Write failing update tamper tests**

For a complete coverage-enabled run, independently mutate:

1. `source-coverage.json` content;
2. run-state `coverageCatalogHash`;
3. global-state `coverageCatalogHash`;
4. validation `coverageCatalogHash`.

For every subtest, assert `runUpdate()` rejects with code `coverage_catalog_hash_mismatch` before the local Redmine server records a request.

- [ ] **Step 2: Run update tests and verify RED**

```bash
rtk node --test lib/__tests__/report-update-v2.test.js
```

Expected: at least one tamper branch reaches the existing publish path or maps to a generic code.

- [ ] **Step 3: Add coverage evidence mapping and non-overridable ownership checks**

Extend `NON_OVERRIDABLE_V2_CODES`, `mapRunEvidenceError()`, and `assertV2PublishEvidence()` so coverage-enabled runs require equality across:

- run catalog intrinsic hash;
- run state;
- global generation state;
- latest validation artifact.

Do not require these fields from a coverage-free historical run.

- [ ] **Step 4: Run update tests and verify GREEN**

Expected: all tamper cases are blocked with zero Redmine requests.

- [ ] **Step 5: Add an explicit historical schema-v2 compatibility test**

Use the pre-coverage fixture shape with no source mode, hash, or artifact. Assert `assertRunInputs()` and the existing update evidence path do not fail solely because coverage fields are absent.

- [ ] **Step 6: Run compatibility test and verify RED, then GREEN**

If it initially fails, narrow the new checks to `state.sourceCoverageMode` and rerun. Do not synthesize a coverage catalog for an old run.

- [ ] **Step 7: Run mode and update suites**

```bash
rtk node --test lib/__tests__/index-modes.test.js lib/__tests__/report-update-v2.test.js
```

Expected: all tests PASS.

- [ ] **Step 8: Record a commit checkpoint without committing**

Run `rtk git diff --check`; retain changes uncommitted.

---

### Task 7: Documentation, complete regression, and static review

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-01-report-source-coverage-contract-design.md`
- Review: every file changed in Tasks 1-6

**Interfaces:**
- Documentation must describe `source-coverage.json`, source marker manual repair, and coverage-specific fail-closed update behavior.

- [ ] **Step 1: Update operator documentation**

Document:

- the new run artifact and pinned hash fields;
- `C` and `N` marker meanings;
- that all Notion markers and populated configured sections are mandatory;
- that manual repair happens only in `draft.working.annotated.md` followed by `MODE=revalidate`;
- that validation failure never triggers a second Claude call;
- that real Claude pilot and Redmine publication require separate approval.

Change the design status from `검토 대기` to `승인됨(2026-09-01)`.

- [ ] **Step 2: Run every focused changed-area suite**

```bash
rtk node --test \
  lib/__tests__/source-coverage.test.js \
  lib/__tests__/report-contract.test.js \
  lib/__tests__/fact-catalog.test.js \
  lib/__tests__/fact-references.test.js \
  lib/__tests__/fact-contract-validator.test.js \
  lib/__tests__/publisher-ai-budget.test.js \
  lib/__tests__/report-run.test.js \
  lib/__tests__/report-generate-v2.test.js \
  lib/__tests__/report-revalidate.test.js \
  lib/__tests__/report-update-v2.test.js \
  lib/__tests__/index-modes.test.js
```

Expected: exit 0, zero failures.

- [ ] **Step 3: Run the full repository test command**

```bash
rtk node --test --test-reporter=dot lib/__tests__/*.test.js
```

Expected: exit 0; count the dots/tests and report the exact total.

- [ ] **Step 4: Run syntax and whitespace checks**

```bash
rtk node --check index.js
rtk node --check lib/source-coverage.js
rtk node --check lib/report-contract.js
rtk git diff --check
```

Expected: every command exits 0 with no errors.

- [ ] **Step 5: Inspect the final diff against the issue acceptance criteria**

Run:

```bash
rtk git status --short
rtk git diff --stat
rtk git diff -- index.js lib/source-coverage.js lib/report-contract.js lib/fact-catalog.js lib/fact-references.js lib/fact-validator.js lib/publisher.js lib/report-run.js README.md
```

Verify explicitly that:

- the incident fixture fails before the fix and passes after it;
- source-marker failures are non-overridable;
- old schema-v2 compatibility is covered;
- no test or implementation starts a real external process other than fake local CLIs/servers;
- no Redmine publish or real Claude pilot occurred.

- [ ] **Step 6: Stop before commit, push, PR, pilot, or publication**

Report the verified state and changed files to the user. Wait for an explicit instruction before any commit or external action.
