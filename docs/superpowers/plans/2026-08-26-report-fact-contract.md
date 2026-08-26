# Report Fact Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind every AI-generated protected fact to a deterministic source fact, preserve every rejected run, and allow zero-LLM manual revalidation before Redmine publication.

**Architecture:** AI-enabled generate builds a fact catalog from the sealed snapshot, injects ready-to-copy fact markers into the existing Claude prompt, stores raw and sanitized annotated drafts in an attempt directory, and promotes clean Markdown only after schema v2 validation. Legacy schema v1 remains for already-generated drafts and `AI_SUMMARIZE=0`; schema v2 update pins the clean report hash and reruns only mutable publish-time checks.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, `node:assert`, `fs`, `path`, `crypto`, existing Claude CLI fake-process tests, localhost HTTP boundary tests; no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-report-fact-contract-design.md`

## Global Constraints

- Prefix every execution shell command with `rtk` per `/home/jhw/.codex/RTK.md`.
- Follow repository `AGENTS.md`: open-status claims still require latest git title and pickaxe checks.
- AI-enabled generate uses `sonnet`, effort `low`, maximum prompt length `100000`, timeout `300000ms`, and at most one Claude call per run unless existing environment overrides lower operational budgets.
- Validation failure must never trigger another Claude call.
- Schema v2 generation copies protected numbers, PASS notation, units, and counters from the source literal; aggregation, arithmetic, conversion, averaging, and rounding are forbidden.
- Schema v2 marker, fact, snapshot/catalog, and clean-report hash errors cannot be bypassed by `VALIDATION_OVERRIDE=1`.
- `AI_SUMMARIZE=0` and pre-existing schema v1 generation states keep the current deterministic/legacy validation path.
- Never overwrite the immutable Claude stdout or an earlier validation revision.
- Never change the canonical report before schema v2 validation is publishable.
- Tests must not call the real Claude or Redmine endpoints; use fake CLI programs and localhost HTTP servers.
- Do not add artifact retention or automatic deletion in this issue.
- Use TDD for every behavior: observe the targeted test fail, implement only enough to pass, then run affected and full suites.

## File Structure

**Create**

- `lib/fact-catalog.js` — occurrence-aware source fact catalog and prompt serialization.
- `lib/annotated-draft.js` — fact-marker parser, location mapping, masking, and clean rendering.
- `lib/report-run.js` — safe run paths, immutable artifacts, validation revisions, state transitions, and atomic promotion.
- `lib/__tests__/fact-catalog.test.js` — deterministic catalog and source-location tests.
- `lib/__tests__/annotated-draft.test.js` — marker grammar and rendering tests.
- `lib/__tests__/fact-contract-validator.test.js` — schema v2 contract and incident fixtures.
- `lib/__tests__/report-run.test.js` — artifact immutability, path safety, revisions, and promotion tests.
- `lib/__tests__/report-generate-v2.test.js` — AI-enabled schema v2 generate integration tests.
- `lib/__tests__/report-revalidate.test.js` — zero-LLM revalidation integration tests.
- `lib/__tests__/report-update-v2.test.js` — schema v2 update/hash/override boundary tests.
- `lib/__tests__/helpers/report-run-fixture.js` — schema v2 generate/revalidate/update tests의 공용 snapshot, fake Claude, localhost Redmine fixture.
- `lib/__tests__/fixtures/report-fact-incidents.json` — frozen `5/8`, changed PASS result, and `16건→16개` cases.

**Modify**

- `lib/fact-validator.js` — occurrence APIs, non-fact rule reuse, and schema v2 validation entry point.
- `lib/publisher.js` — pure prompt builder, fact-contract prompt block, and content-returning generation API.
- `lib/report-artifact.js` — generation schema constants and shared hash/path helpers only where reused by run storage.
- `lib/config.js` — expose `RUN_ID` without making Redmine credentials mandatory for revalidate.
- `index.js` — schema v1/v2 generate dispatch, revalidate mode, v2 update gate, and non-overridable errors.
- `lib/__tests__/fact-validator.test.js` — prove schema v1 behavior remains unchanged.
- `lib/__tests__/publisher-ai-budget.test.js` — prompt contract and input-budget coverage.
- `lib/__tests__/index-modes.test.js` — mode dispatch and schema v1 compatibility coverage.
- `lib/__tests__/config-read-json.test.js` — `RUN_ID` and revalidate credential-boundary coverage.
- `README.md` — run artifacts, exact-copy contract, revalidate command, and failure recovery.

---

### Task 1: Occurrence-Aware Fact Catalog

**Files:**
- Create: `lib/fact-catalog.js`
- Create: `lib/__tests__/fact-catalog.test.js`
- Modify: `lib/fact-validator.js:15-145`
- Modify: `lib/__tests__/fact-validator.test.js`

**Interfaces:**
- Produces: `extractTestFactOccurrences(text) -> TestFactOccurrence[]`
- Produces: `extractProtectedTokenOccurrences(text) -> ProtectedOccurrence[]`
- Produces: `extractCountedQuantityOccurrences(text) -> CountedOccurrence[]`
- Produces: `buildFactCatalog(rawContent, systemFacts = []) -> FactCatalog`
- Produces: `formatFactCatalogForPrompt(catalog) -> string`
- Private: `mergeAndNumberOccurrences(rawContent, systemFacts) -> FactEntry[]`; it is implemented in this task, not imported from another module.
- `FactCatalog = {schemaVersion: 1, catalogHash: string, facts: FactEntry[]}`
- Existing `extractTestFacts()`, `extractProtectedTokens()`, `validateReport()` signatures remain compatible.

- [ ] **Step 1: Write failing occurrence and catalog tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { buildFactCatalog, formatFactCatalogForPrompt } = require("../fact-catalog");

test("catalog binds test and counter facts to stable source locations", () => {
  const raw = [
    "#### 조현우",
    "- 보드 실행 5/8 PASS",
    "- 플릿 16건 저장소 전면 배포",
  ].join("\n");
  const systemFacts = [{ type: "meeting_date", raw: "2026-08-26", subject: "meeting date" }];

  const first = buildFactCatalog(raw, systemFacts);
  const second = buildFactCatalog(raw, systemFacts);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.facts.find((fact) => fact.id === "T0001").raw, "5/8 PASS");
  assert.deepStrictEqual(first.facts.find((fact) => fact.id === "T0001").semantic, {
    pass: 5, total: 8, fail: 3,
  });
  assert.strictEqual(first.facts.find((fact) => fact.id === "Q0001").raw, "16건");
  assert.strictEqual(first.facts.find((fact) => fact.id === "Q0001").subject, "저장소");
  assert.strictEqual(first.facts.find((fact) => fact.id === "S0001").raw, "2026-08-26");
  assert.match(formatFactCatalogForPrompt(first), /\[\[fact:T0001\|5\/8 PASS\]\]/);
});

test("catalog keeps duplicate surfaces as separate source occurrences", () => {
  const catalog = buildFactCatalog("A 3건 작업\nB 3건 작업\n");
  const quantities = catalog.facts.filter((fact) => fact.id.startsWith("Q"));
  assert.deepStrictEqual(quantities.map((fact) => fact.id), ["Q0001", "Q0002"]);
  assert.deepStrictEqual(quantities.map((fact) => fact.sourceLocation.line), [1, 2]);
});
```

- [ ] **Step 2: Run tests and confirm the expected red state**

Run:

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-validator.test.js
```

Expected: FAIL with `Cannot find module '../fact-catalog'` while existing validator assertions remain otherwise unchanged.

- [ ] **Step 3: Add occurrence APIs without changing legacy semantics**

Refactor each current regex scanner so the occurrence form carries location data and the legacy API maps it back to its old return value.

```js
function locate(text, start, end) {
  const before = String(text).slice(0, start);
  const lines = before.split("\n");
  return { start, end, line: lines.length, column: lines.at(-1).length + 1 };
}

function extractTestFacts(text) {
  return extractTestFactOccurrences(text).map(({ start, end, line, column, ...fact }) => fact);
}

function extractProtectedTokens(text) {
  return new Set(extractProtectedTokenOccurrences(text).map((item) => item.normalized));
}
```

Export the three occurrence APIs while keeping the four current exports.

- [ ] **Step 4: Implement deterministic catalog construction**

```js
const { hashObject } = require("./report-artifact");
const {
  extractTestFactOccurrences,
  extractProtectedTokenOccurrences,
  extractCountedQuantityOccurrences,
} = require("./fact-validator");

function finalizeCatalog(facts) {
  const payload = { schemaVersion: 1, facts };
  return { ...payload, catalogHash: hashObject(payload) };
}

function buildFactCatalog(rawContent, systemFacts = []) {
  const facts = mergeAndNumberOccurrences(rawContent, systemFacts);
  return finalizeCatalog(facts);
}
```

Implement `mergeAndNumberOccurrences()` in `lib/fact-catalog.js` with this exact sequence:

1. Collect test-result occurrences first and record their `[start,end)` spans.
2. Collect counted-quantity occurrences outside those spans, then remaining protected-token occurrences outside both prior span sets.
3. Sort source-derived entries by `start`, then by type order `T`, `Q`, `V`; append caller-supplied system facts as `S` entries in array order.
4. Assign independent four-digit counters (`T0001`, `Q0001`, `V0001`, `S0001`) without deduplicating equal surfaces.
5. Copy `raw`, `semantic`, `subject`, `sourceLocation`, `sourceExcerpt`, and the closed `allowedNormalizations` list into each entry. System facts use `sourceLocation: null` and `sourceExcerpt: null`.

- [ ] **Step 5: Run focused and full legacy validator tests**

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/fact-validator.test.js
```

Expected: all focused tests PASS, including the existing generic-counter schema v1 tests.

- [ ] **Step 6: Commit the catalog boundary**

```bash
rtk git add lib/fact-catalog.js lib/fact-validator.js lib/__tests__/fact-catalog.test.js lib/__tests__/fact-validator.test.js
rtk git commit -m "feat(report): source fact catalog 추가"
```

### Task 2: Annotated Markdown Parser and Renderer

**Files:**
- Create: `lib/annotated-draft.js`
- Create: `lib/__tests__/annotated-draft.test.js`

**Interfaces:**
- Consumes: fact IDs and raw surfaces produced by Task 1.
- Produces: `parseAnnotatedDraft(content) -> {claims, errors, cleanContent, markedCleanSpans}`
- Produces: `renderCleanDraft(content) -> string`, which throws when marker syntax is malformed.
- `Claim = {factId, surface, annotatedStart, annotatedEnd, cleanStart, cleanEnd, outputLocation}`.

- [ ] **Step 1: Write failing grammar, location, and rendering tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { parseAnnotatedDraft, renderCleanDraft } = require("../annotated-draft");

test("parser renders marker surfaces and preserves output locations", () => {
  const input = "#### 조현우\n- 결과 [[fact:T0001|5/8 PASS]]\n";
  const parsed = parseAnnotatedDraft(input);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.claims[0].factId, "T0001");
  assert.deepStrictEqual(parsed.claims[0].outputLocation, { line: 2, column: 6 });
  assert.strictEqual(parsed.cleanContent, "#### 조현우\n- 결과 5/8 PASS\n");
  assert.strictEqual(renderCleanDraft(input), parsed.cleanContent);
});

test("parser reports every malformed marker instead of guessing", () => {
  const parsed = parseAnnotatedDraft("[[fact:|5건]]\n[[fact:Q0001|]]\n[[fact:Q0002|5건");
  assert.deepStrictEqual(parsed.errors.map((error) => error.code), [
    "malformed_fact_marker", "malformed_fact_marker", "malformed_fact_marker",
  ]);
});
```

- [ ] **Step 2: Run the parser test and observe module-not-found failure**

```bash
rtk node --test lib/__tests__/annotated-draft.test.js
```

Expected: FAIL with `Cannot find module '../annotated-draft'`.

- [ ] **Step 3: Implement a single-pass parser**

Use an index-based scanner, not one permissive regex, so malformed and nested markers have stable locations.

```js
function parseAnnotatedDraft(content) {
  const source = String(content);
  const claims = [];
  const errors = [];
  const clean = [];
  const markedCleanSpans = [];
  return { claims, errors, cleanContent: clean.join(""), markedCleanSpans };
}

function renderCleanDraft(content) {
  const parsed = parseAnnotatedDraft(content);
  if (parsed.errors.length) {
    const error = new Error("annotated draft contains malformed fact markers");
    error.code = "MALFORMED_FACT_MARKER";
    error.issues = parsed.errors;
    throw error;
  }
  return parsed.cleanContent;
}
```

Fill the arrays in `parseAnnotatedDraft()` with an index-based `while (cursor < source.length)` scanner. Copy ordinary text one character at a time; on `[[fact:` locate the next `]]`, reject an intervening `[[`, split the body at the first `|`, validate `/^[TQVS]\d{4}$/` and a non-empty surface, append only the surface to `clean`, and record both annotated and clean half-open offsets. Every malformed opening advances past the nearest safe boundary and appends one `malformed_fact_marker` with line/column, so later independent errors are still collected. Reject nested `[[`, embedded `]]` in a surface, empty fields, invalid IDs, and unterminated markers.

- [ ] **Step 4: Run parser tests**

```bash
rtk node --test lib/__tests__/annotated-draft.test.js
```

Expected: all parser tests PASS.

- [ ] **Step 5: Commit the parser**

```bash
rtk git add lib/annotated-draft.js lib/__tests__/annotated-draft.test.js
rtk git commit -m "feat(report): annotated fact marker 파서 추가"
```

### Task 3: Schema v2 Validator and Incident Fixtures

**Files:**
- Create: `lib/__tests__/fact-contract-validator.test.js`
- Create: `lib/__tests__/fixtures/report-fact-incidents.json`
- Modify: `lib/fact-validator.js:147-284`

**Interfaces:**
- Consumes: `FactCatalog` from Task 1 and parsed claims from Task 2.
- Produces: `validateAnnotatedReport(rawContent, annotatedContent, catalog, options) -> {validation, cleanContent}`.
- Produces: `validateNonFactRules(reportContent, options) -> {issues, openIssueChecks}` for reuse at publish time.
- Private helpers implemented in this task: `validateLegacyFacts()`, `buildLegacyValidation()`, `validateClaim()`, `findUnmarkedProtectedFacts()`, `extractSchemaV2UnmarkedOccurrences()`, and `statusFromIssues()`; they contain the current schema v1 blocks or the new deterministic schema v2 checks described below.
- `validation.schemaVersion === 2` and includes `attemptId`, `snapshotHash`, `catalogHash`, `annotatedDraftHash`, `checkedAt`, `issues`; `cleanReportHash` is attached only by a publishable orchestration step.

- [ ] **Step 1: Add the frozen incident fixture**

```json
{
  "raw": "#### <span style=\"color:blue\">조현우</span>\n- 보드 실행 5/8 PASS\n- 플릿 16건 저장소 전면 배포\n",
  "valid": "#### <span style=\"color:blue\">조현우</span>\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n- 플릿 [[fact:Q0001|16건]] 저장소 전면 배포\n",
  "changedRatio": "#### <span style=\"color:blue\">조현우</span>\n- 보드 실행 [[fact:T0001|10/11 PASS]]\n",
  "changedPassFail": "#### <span style=\"color:blue\">조현우</span>\n- 보드 실행 [[fact:T0001|10건 PASS, 실패 1건]]\n",
  "changedCounter": "#### <span style=\"color:blue\">조현우</span>\n- 플릿 [[fact:Q0001|16개]] 저장소 전면 배포\n"
}
```

- [ ] **Step 2: Write failing contract tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const fixture = require("./fixtures/report-fact-incidents.json");
const { buildFactCatalog } = require("../fact-catalog");
const { validateAnnotatedReport } = require("../fact-validator");

function baseOptions() {
  return {
    attemptId: "11111111-1111-4111-8111-111111111111",
    meetingDate: "2026-08-26",
    reportDepth: 3,
    snapshotHash: "fixture-snapshot-hash",
    snapshotPath: "/fixture/report.snapshot.json",
    sectionHeader: '#### <span style="color:blue">조현우</span>',
  };
}

test("schema v2 accepts exact facts and rejects both production mutations", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const valid = validateAnnotatedReport(fixture.raw, fixture.valid, catalog, baseOptions());
  assert.strictEqual(valid.validation.status, "PASS");
  assert.strictEqual(valid.cleanContent.includes("[[fact:"), false);

  for (const content of [fixture.changedRatio, fixture.changedPassFail, fixture.changedCounter]) {
    const result = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions());
    assert.strictEqual(result.validation.status, "FAIL");
    const issue = result.validation.issues.find((candidate) => candidate.code === "fact_value_mismatch");
    assert.ok(issue);
    assert.ok(issue.value);
    assert.ok(issue.factId);
    assert.deepStrictEqual(issue.expected, [catalog.facts.find((fact) => fact.id === issue.factId).raw]);
    assert.ok(issue.sourceLocation);
    assert.ok(issue.sourceExcerpt);
    assert.ok(issue.outputLocation);
    assert.ok(issue.outputExcerpt);
  }
});

test("schema v2 reports unmarked and independent section errors together", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const content = `${fixture.valid}\n- invented 77건\n- 다른 줄 [[fact:Q9999|16건]]\n`;
  const { validation } = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions());
  assert.deepStrictEqual(
    validation.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).sort(),
    ["unknown_fact_id", "unmarked_protected_fact"]
  );
});

test("schema v2 accepts only closed normalization and binds counted subjects", () => {
  const raw = `${fixture.raw}- 센서 16건 점검\n`;
  const catalog = buildFactCatalog(raw);
  const spaced = fixture.valid.replace("5/8 PASS", "5 / 8 PASS");
  assert.strictEqual(validateAnnotatedReport(raw, spaced, catalog, baseOptions()).validation.status, "PASS");

  const wrongSubject = `${fixture.valid}\n- 센서 [[fact:Q0001|16건]] 점검\n`;
  const wrong = validateAnnotatedReport(raw, wrongSubject, catalog, baseOptions()).validation;
  assert.ok(wrong.issues.some((issue) => issue.code === "fact_subject_mismatch"));
});

test("schema v2 rejects arithmetic, conversion, and rounding outside markers", () => {
  const catalog = buildFactCatalog(fixture.raw);
  const content = `${fixture.valid}\n- 파생 집계 13건, 비율 62.5%, 평균 2.7건\n`;
  const validation = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions()).validation;
  assert.ok(validation.issues.filter((issue) => issue.code === "unmarked_protected_fact").length >= 3);
});

test("schema v2 requires an explicit system-fact marker for an ISO date", () => {
  const catalog = buildFactCatalog(fixture.raw, [
    { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
  ]);
  const content = `${fixture.valid}\n- 회의일 2026-08-26\n`;
  const validation = validateAnnotatedReport(fixture.raw, content, catalog, baseOptions()).validation;
  assert.ok(validation.issues.some((issue) => issue.code === "unmarked_protected_fact"));
});
```

- [ ] **Step 3: Run tests and verify the missing API failure**

```bash
rtk node --test lib/__tests__/fact-contract-validator.test.js
```

Expected: FAIL because `validateAnnotatedReport` is not exported.

- [ ] **Step 4: Extract reusable non-fact validation without changing schema v1**

```js
function validateNonFactRules(reportContent, options = {}) {
  const issues = [];
  const openIssueChecks = [];
  return { issues, openIssueChecks };
}

function validateReport(rawContent, reportContent, options = {}) {
  const issues = validateLegacyFacts(rawContent, reportContent);
  const nonFacts = validateNonFactRules(reportContent, options);
  issues.push(...nonFacts.issues);
  return buildLegacyValidation(rawContent, reportContent, options, issues, nonFacts.openIssueChecks);
}
```

Move the current open-status/as-of loop, section-header checks, underline-balance check, and `verifyOpenIssueClaims()` call into `validateNonFactRules()`. Its `issues` is the concatenation of those four blocks and `openIssueChecks` is exactly `openIssueVerification.checks`. Move only the current test-fact/protected-token blocks into `validateLegacyFacts()`. `buildLegacyValidation()` must return the current schema v1 object byte-for-byte in field meaning and call `statusFromIssues()` for status. Run the existing fact-validator suite immediately after this refactor to prove schema v1 stayed green.

- [ ] **Step 5: Implement schema v2 validation and closed normalizers**

```js
function validateAnnotatedReport(rawContent, annotatedContent, catalog, options = {}) {
  const parsed = parseAnnotatedDraft(annotatedContent);
  const issues = [...parsed.errors];
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  for (const claim of parsed.claims) validateClaim(claim, byId, parsed.cleanContent, issues);
  findUnmarkedProtectedFacts(parsed.cleanContent, parsed.markedCleanSpans, issues);
  const nonFacts = validateNonFactRules(parsed.cleanContent, options);
  issues.push(...nonFacts.issues);
  const status = statusFromIssues(issues);
  return {
    cleanContent: parsed.cleanContent,
    validation: {
      schemaVersion: 2,
      status,
      attemptId: options.attemptId,
      snapshotHash: options.snapshotHash,
      catalogHash: catalog.catalogHash,
      annotatedDraftHash: sha256(annotatedContent),
      checkedAt: new Date().toISOString(),
      facts: { openIssueChecks: nonFacts.openIssueChecks },
      issues,
    },
  };
}
```

`validateClaim()` looks up the ID, emits `unknown_fact_id` when absent, compares the surface to exact `raw` plus the spec's closed whitespace/version/multiplication-symbol normalizers, and emits `fact_value_mismatch` with value/factId/expected/source/output evidence on failure. It never applies `GENERIC_COUNTER_TOKEN`, arithmetic, PASS syntax reordering, or cross-fact aggregation. For `Q` facts only, run counted-target comparison when the deterministic quantity parser yields a subject around the clean claim span and emit `fact_subject_mismatch` on a mismatch. `extractSchemaV2UnmarkedOccurrences()` combines test/protected/counted occurrence scans, an ISO `YYYY-MM-DD` scan, and literal occurrences of catalog `S` surfaces, then de-duplicates overlapping spans. `findUnmarkedProtectedFacts()` masks `markedCleanSpans`, runs that schema v2-only scanner over the remaining clean text, and emits one `unmarked_protected_fact` per occurrence with output location. This leaves schema v1 token extraction unchanged. `statusFromIssues()` uses the current error → warning → pass precedence.

- [ ] **Step 6: Run schema v1 and v2 validator tests**

```bash
rtk node --test lib/__tests__/fact-validator.test.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/open-issue-verifier.test.js
```

Expected: all tests PASS; production incident mutations yield `fact_value_mismatch` with source/output locations.

- [ ] **Step 7: Commit the v2 validation contract**

```bash
rtk git add lib/fact-validator.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/fixtures/report-fact-incidents.json
rtk git commit -m "feat(report): schema v2 fact validation 추가"
```

### Task 4: Immutable Run Artifact Store

**Files:**
- Create: `lib/report-run.js`
- Create: `lib/__tests__/report-run.test.js`
- Modify: `lib/report-artifact.js:1-150`
- Modify: `lib/__tests__/report-artifact.test.js`

**Interfaces:**
- Produces: `buildRunPaths(outputDir, meetingDate, attemptId) -> RunPaths`.
- Produces: `initializeReportRun(paths, state) -> state`.
- Produces: `writeImmutableArtifact(filePath, content) -> void`.
- Produces: `updateRunState(paths, expectedAttemptId, patch) -> state`.
- Produces: `appendValidationRevision(paths, expectedAttemptId, validation) -> {revision, validationPath, state}`.
- Produces: `loadReportRun(outputDir, meetingDate, attemptId) -> {paths, state, catalog}`.
- Produces: `assertRunInputs(state, snapshot, catalog, expected) -> void`.
- Produces: `assertGenerationStateOwned(generationStatePath, attemptId) -> state`.
- Produces: `promoteRunReport({paths, reportPath, generationStatePath, cleanContent, validation, generationState}) -> state`.
- Private: `makeRunPaths(runDir) -> RunPaths` with the exact filenames from the design.

- [ ] **Step 1: Write failing path, immutability, revision, and promotion tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendValidationRevision,
  buildRunPaths,
  initializeReportRun,
  updateRunState,
  writeImmutableArtifact,
} = require("../report-run");

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

function makeRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-report-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("run storage preserves immutable AI output and every validation revision", (t) => {
  const dir = makeRunDir(t);
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  initializeReportRun(paths, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  writeImmutableArtifact(paths.aiDraftPath, "raw stdout");
  assert.throws(() => writeImmutableArtifact(paths.aiDraftPath, "overwrite"), /immutable/);
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  const first = appendValidationRevision(paths, ATTEMPT_ID, { schemaVersion: 2, status: "FAIL" });
  updateRunState(paths, ATTEMPT_ID, { status: "validation_failed" });
  const second = appendValidationRevision(paths, ATTEMPT_ID, { schemaVersion: 2, status: "PASS" });
  assert.strictEqual(path.basename(first.validationPath), "validation.001.json");
  assert.strictEqual(path.basename(second.validationPath), "validation.002.json");
  assert.strictEqual(fs.existsSync(first.validationPath), true);
});

test("run IDs cannot escape the meeting-date root", (t) => {
  const dir = makeRunDir(t);
  assert.throws(() => buildRunPaths(dir, "2026-08-26", "../../escape"), /UUID/);
});

test("run state rejects transitions outside the designed state graph", (t) => {
  const dir = makeRunDir(t);
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  initializeReportRun(paths, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  assert.throws(() => updateRunState(paths, ATTEMPT_ID, { status: "complete" }), /transition/);
});

test("a superseded run cannot promote its clean report", (t) => {
  const dir = makeRunDir(t);
  const paths = buildRunPaths(dir, "2026-08-26", ATTEMPT_ID);
  const reportPath = path.join(dir, "report.md");
  const generationStatePath = path.join(dir, "report.generation.json");
  initializeReportRun(paths, { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "running" });
  updateRunState(paths, ATTEMPT_ID, { status: "ai_complete" });
  writeJsonAtomic(generationStatePath, { schemaVersion: 2, attemptId: "newer-attempt", status: "running" });
  assert.throws(() => promoteRunReport({
    paths,
    reportPath,
    generationStatePath,
    cleanContent: "clean\n",
    validation: { schemaVersion: 2, status: "PASS", cleanReportHash: sha256("clean\n") },
    generationState: { schemaVersion: 2, attemptId: ATTEMPT_ID, status: "complete" },
  }), /superseded/);
  assert.strictEqual(fs.existsSync(reportPath), false);
});
```

Add `promoteRunReport` to the `report-run` test import and `sha256`, `writeJsonAtomic` to its `report-artifact` import.

- [ ] **Step 2: Run the tests and observe module-not-found failure**

```bash
rtk node --test lib/__tests__/report-run.test.js
```

Expected: FAIL with `Cannot find module '../report-run'`.

- [ ] **Step 3: Implement safe paths and immutable/revision writes**

```js
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function makeRunPaths(runDir) {
  return {
    runDir,
    statePath: path.join(runDir, "state.json"),
    catalogPath: path.join(runDir, "fact-catalog.json"),
    promptInputPath: path.join(runDir, "prompt-input.json"),
    aiDraftPath: path.join(runDir, "draft.ai.annotated.md"),
    workingDraftPath: path.join(runDir, "draft.working.annotated.md"),
    cleanReportPath: path.join(runDir, "report.clean.md"),
  };
}

function buildRunPaths(outputDir, meetingDate, attemptId) {
  if (!DATE_RE.test(meetingDate)) throw new Error("meeting date must be YYYY-MM-DD");
  if (!UUID_RE.test(attemptId)) throw new Error("RUN_ID must be a UUID");
  const runRoot = path.resolve(outputDir, "runs", meetingDate);
  const runDir = path.resolve(runRoot, attemptId);
  if (path.dirname(runDir) !== runRoot) throw new Error("run path escapes root");
  return makeRunPaths(runDir);
}

function writeImmutableArtifact(filePath, content) {
  if (fs.existsSync(filePath)) throw new Error(`immutable artifact already exists: ${filePath}`);
  writeTextAtomic(filePath, content);
}
```

`updateRunState()` enforces only `running→ai_failed|ai_complete`, `ai_complete→validation_failed|complete`, and `validation_failed→validation_failed|complete`; patches without `status` keep the current state. `loadReportRun()` resolves the existing run directory with `fs.realpathSync()`, proves its parent is the real meeting-date root, reads `state.json` and `fact-catalog.json`, and rejects any attempt-ID mismatch. `assertRunInputs()` checks schema v2, attempt ID, meeting date, report depth, snapshot hash, `catalog.catalogHash === state.catalogHash`, and `hashObject({schemaVersion: catalog.schemaVersion, facts: catalog.facts}) === catalog.catalogHash`. `assertGenerationStateOwned()` reads the global state and rejects a missing, unreadable, or different attempt as `GENERATION_SUPERSEDED`. Validation revisions are numbered from state, written before the state pointer changes, and referenced by relative basename only.

- [ ] **Step 4: Implement ownership-checked state and atomic promotion**

```js
function promoteRunReport(args) {
  if (args.validation.schemaVersion !== 2 || !args.validation.cleanReportHash) {
    throw new Error("publishable schema v2 validation required");
  }
  writeTextAtomic(args.paths.cleanReportPath, args.cleanContent);
  assertGenerationStateOwned(args.generationStatePath, args.generationState.attemptId);
  writeTextAtomic(args.reportPath, args.cleanContent);
  assertGenerationStateOwned(args.generationStatePath, args.generationState.attemptId);
  writeJsonAtomic(args.generationStatePath, args.generationState);
  return updateRunState(args.paths, args.generationState.attemptId, {
    status: "complete", completedAt: new Date().toISOString(),
  });
}
```

If the process stops between report and generation-state writes, update remains blocked because the global state is not complete. Never mark complete before the canonical report and hashes exist.

- [ ] **Step 5: Run artifact tests**

```bash
rtk node --test lib/__tests__/report-run.test.js lib/__tests__/report-artifact.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit run storage**

```bash
rtk git add lib/report-run.js lib/report-artifact.js lib/__tests__/report-run.test.js lib/__tests__/report-artifact.test.js
rtk git commit -m "feat(report): immutable run artifact 저장소 추가"
```

### Task 5: Fact-Constrained Prompt and Content API

**Files:**
- Modify: `lib/publisher.js:281-478,591-633,796-820`
- Modify: `lib/__tests__/publisher-ai-budget.test.js`

**Interfaces:**
- Consumes: `formatFactCatalogForPrompt()` from Task 1.
- Produces: `buildFactContractGuidance(catalog) -> string`.
- Produces: `buildAiPrompt(rawContent, config, meetingDate, options = {}) -> string`.
- Changes compatibly: `aiSummarize(rawContent, config, meetingDate, options = {}) -> Promise<string|null>`.
- Produces: `generateContent(config, meetingDate, rawContent, options = {}) -> Promise<{usedAi, rawAiOutput, content, prompt, promptHash}>`.
- Existing `generate()` remains and delegates to `generateContent()` before writing the legacy output path.

- [ ] **Step 1: Write failing prompt-contract tests**

Add assertions to the existing fake CLI test by reading the argument after `-p`.

```js
const catalog = buildFactCatalog("보드 실행 5/8 PASS\n플릿 16건 저장소 전면 배포");
const result = await aiSummarize("원본", config, meetingDate, { factCatalog: catalog });
const args = JSON.parse(result);
const prompt = args[args.indexOf("-p") + 1];
assert.match(prompt, /\[\[fact:T0001\|5\/8 PASS\]\]/);
assert.match(prompt, /숫자.*표기 순서.*단위.*조수사.*바꾸지/);
assert.match(prompt, /합산.*차감.*집계/);
assert.match(prompt, /환산.*평균.*반올림/);
assert.doesNotMatch(prompt, /출력은 `N건 PASS, 실패 M건`/);
```

Add a budget assertion that a catalog-expanded prompt exceeding `AI_MAX_INPUT_CHARS` fails before the fake CLI marker file appears.

- [ ] **Step 2: Run prompt tests and verify they fail on missing catalog rules**

```bash
rtk node --test lib/__tests__/publisher-ai-budget.test.js
```

Expected: FAIL because the prompt lacks fact markers/exact-copy rules or the fourth argument is ignored.

- [ ] **Step 3: Extract a pure prompt builder and add the fact block**

Move the current prompt template byte-for-byte into `buildAiPrompt()`, preserving all existing depth/filter/as-of interpolation. Delete the current `테스트 결과 표기` line that authorizes representation conversion. Immediately before `## 삭제 대상`, insert `buildFactContractGuidance(options.factCatalog)`. Its non-empty result is exactly these lines followed by `formatFactCatalogForPrompt(catalog)`:

```text
## 허용 사실 — marker 전체를 원문 그대로 복사
- 수치·버전·날짜·PASS/FAIL 결과가 필요하면 아래 catalog marker 전체를 그대로 복사한다.
- marker surface의 숫자, 표기 순서, 단위, 조수사를 바꾸지 않는다.
- PASS N/M, N/M PASS, N건 PASS·실패 M건 사이를 변환하지 않는다.
- 개·건·회, 물리 단위, 버전 접두를 임의 변경하지 않는다.
- 여러 근거를 합산·차감·집계하지 않는다.
- 환산·비율 계산·평균·반올림·범위 축약을 하지 않는다.
- catalog에 없는 숫자가 필요하면 숫자를 생략하며, 쓰지 않는 사실은 marker를 출력하지 않는다.
```

When no catalog is passed, `buildFactContractGuidance()` returns an empty string and the legacy prompt differs only by removal of the unsafe conversion instruction. Change `aiSummarize()` to accept `options = {}` and select `options.prompt || buildAiPrompt(rawContent, config, meetingDate, options)`; keep Task #24's prompt-size check, one spawn, timeout, kill escalation, and error classification unchanged.

- [ ] **Step 4: Add the content-returning generation API**

```js
async function generateContent(config, meetingDate, rawContent, options = {}) {
  const prompt = options.prompt || buildAiPrompt(rawContent, config, meetingDate, options);
  const summarized = await aiSummarize(rawContent, config, meetingDate, { ...options, prompt });
  return {
    usedAi: summarized !== null,
    rawAiOutput: summarized,
    content: summarized === null ? rawContent : sanitizeAiSection(summarized, config),
    prompt,
    promptHash: sha256(prompt),
  };
}
```

Import `sha256` from `report-artifact`. Keep `generate()` backward-compatible by calling this function, applying existing note/leader-highlight behavior, and writing the same path for schema v1 callers.

- [ ] **Step 5: Run publisher tests**

```bash
rtk node --test lib/__tests__/publisher-ai-budget.test.js lib/__tests__/publisher-notes.test.js lib/__tests__/publisher-output-path.test.js
```

Expected: all tests PASS; fake CLI invocation remains exactly one.

- [ ] **Step 6: Commit the prompt boundary**

```bash
rtk git add lib/publisher.js lib/__tests__/publisher-ai-budget.test.js
rtk git commit -m "feat(report): fact marker 생성 프롬프트 추가"
```

### Task 6: Schema v2 Generate Orchestration

**Files:**
- Create: `lib/__tests__/report-generate-v2.test.js`
- Create: `lib/__tests__/helpers/report-run-fixture.js`
- Modify: `index.js:157-215,315-344`
- Modify: `lib/__tests__/index-modes.test.js`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, and 5.
- Produces: `runGenerateV2(config, meetingDate) -> {snapshot, snapshotPath, reportPath, generationStatePath, runPaths, validation}`.
- Existing `runGenerate()` dispatches to v2 only when `config.env.aiSummarize === true`; otherwise it executes the unchanged schema v1 path.
- Global schema v2 generation state includes `runDir`, `catalogHash`, `latestValidationPath`, and on success `cleanReportHash`.
- Test helper contract created in this task:
  - `setupSnapshot(t, {rawContent, reportDepth = 3}) -> {dir, meetingDate, config, snapshot, snapshotPath, reportPath, generationStatePath, callsPath, spawnMarkerPath}`.
  - `makeFakeClaude(fixture, output) -> executablePath`; each execution increments `fixture.callsPath` and writes `output` to stdout.
  - `makeSpawnMarker(fixture) -> executablePath`; execution creates `fixture.spawnMarkerPath`, so an absent marker proves zero Claude spawns.

- [ ] **Step 1: Write failing successful-generate integration test**

First create `lib/__tests__/helpers/report-run-fixture.js`. `setupSnapshot()` uses `fs.mkdtempSync()`, registers recursive cleanup with `t.after()`, seals/writes a snapshot with `sealSnapshot()`, and returns a config containing all Task #24 AI defaults (`sonnet`, `low`, `100000`, `300000`, no dollar cap), empty repos/depth profiles/filter, and explicit output/snapshot paths. `makeFakeClaude()` and `makeSpawnMarker()` write executable Node shebang files inside the fixture directory; embed paths and output with `JSON.stringify()` so the generated programs contain no shell interpolation.

```js
test("AI-enabled generate stores schema v2 artifacts and promotes only clean Markdown", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  const aiOutput = `설명 머리말\n${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
  assert.strictEqual(result.validation.schemaVersion, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(result.generationStatePath, "utf8")).status, "complete");
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), aiOutput);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.strictEqual(working, `${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(runState.sanitizer.inputHash, sha256(aiOutput));
  assert.strictEqual(runState.sanitizer.outputHash, sha256(working));
});
```

- [ ] **Step 2: Write failing validation-failure integration test**

```js
test("v2 validation failure preserves the previous report and never retries Claude", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fs.writeFileSync(fixture.reportPath, "previous valid report\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture,
    `${HEADER}\n- 보드 실행 [[fact:T0001|10/11 PASS]]\n`);

  const result = await runGenerate(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8")).status, "validation_failed");
});
```

Import `sha256` in this test from `../report-artifact`. The fake output must end in exactly one newline so the immutable stdout assertion is byte-for-byte stable.

- [ ] **Step 3: Run tests and confirm schema v1 behavior causes the expected failures**

```bash
rtk node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/index-modes.test.js
```

Expected: FAIL because current generate writes the AI draft directly to the canonical path and records schema v1.

- [ ] **Step 4: Implement v1/v2 dispatch and v2 state flow**

```js
async function runGenerate(config, meetingDate) {
  return config.env.aiSummarize
    ? runGenerateV2(config, meetingDate)
    : runGenerateV1(config, meetingDate);
}
```

Implement `runGenerateV2()` in this order:

1. Load the sealed snapshot; derive canonical report/global-state paths; create `attemptId = crypto.randomUUID()` and `runPaths`.
2. Write the schema v2 global state as `running` before any candidate/artifact work, then initialize run `state.json` with the same attempt/date/depth/snapshot ownership.
3. Write presentation candidates, call `buildFactCatalog(snapshot.rawContent, [{type: "meeting_date", raw: formatDate(meetingDate), subject: "meeting date"}])`, immutably write `fact-catalog.json`, build the prompt once, and immutably write `prompt-input.json` with snapshot path/hash, catalog hash, prompt hash, model, effort, prompt length, and timeout.
4. Call `generateContent(config, meetingDate, snapshot.rawContent, {factCatalog: catalog, prompt})` exactly once. Immutably write `rawAiOutput` to `draft.ai.annotated.md` before any section sanitizing and `content` to `draft.working.annotated.md`; record sanitizer input/output hashes and transition the run to `ai_complete`.
5. Call `validateAnnotatedReport()` with attempt/snapshot/date/depth/header/repos and `config.openIssueVerifierOptions` options. If publishable, add `cleanReportHash = sha256(cleanContent)` before `appendValidationRevision()`; otherwise append the failure revision without that field.
6. On FAIL or blocking WARNING, transition the run to `validation_failed`, set the owned global state to `failed` with the latest validation pointer, leave the canonical report untouched, and return the validation so `main()` sets exit code 2 under the default blocking validation mode.
7. On success call `promoteRunReport()` with the clean content, successful revision, and complete global-state payload. Return all paths and validation.
8. Catch Claude/budget/quota/timeout/empty-output errors, transition an initialized run to `ai_failed`, set the owned global state to `failed`, and rethrow the existing distinct error code. Never retry.

- [ ] **Step 5: Preserve schema v1 regression tests**

Extend the existing `AI_SUMMARIZE=0` test to assert `state.schemaVersion === 1` and no `out/runs/<date>/` directory is created.

- [ ] **Step 6: Run generate and artifact suites**

```bash
rtk node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/index-modes.test.js lib/__tests__/report-run.test.js lib/__tests__/publisher-ai-budget.test.js
```

Expected: all tests PASS and each fake CLI call count is exactly one.

- [ ] **Step 7: Commit v2 generate orchestration**

```bash
rtk git add index.js lib/__tests__/helpers/report-run-fixture.js lib/__tests__/report-generate-v2.test.js lib/__tests__/index-modes.test.js
rtk git commit -m "feat(report): schema v2 generate run 통합"
```

### Task 7: Zero-LLM Revalidate Mode

**Files:**
- Create: `lib/__tests__/report-revalidate.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`
- Modify: `lib/config.js:140-205`
- Modify: `lib/__tests__/config-read-json.test.js`
- Modify: `index.js:315-362`

**Interfaces:**
- Produces config field: `config.env.runId` from `RUN_ID`, default `""`.
- Produces: `runRevalidate(config, meetingDate) -> {runPaths, validation, reportPath}`.
- `main()` accepts `MODE=revalidate` and never requires `REDMINE_API_KEY` for that mode.
- Test helper added in this task: `setupFailedV2Run(t) -> Promise<GenerateFixture>`; it calls the real `runGenerate()` once with a fake `10/11 PASS` response and asserts a schema v2 `validation_failed` run before returning the fixture plus `attemptId`, validation, and generated run paths.

- [ ] **Step 1: Write failing config and revalidate tests**

```js
test("revalidate exposes RUN_ID without requiring a Redmine key", () => {
  withEnv({ MODE: "revalidate", RUN_ID: ATTEMPT_ID, REDMINE_API_KEY: undefined }, () => {
    assert.strictEqual(loadConfig().env.runId, ATTEMPT_ID);
  });
});

test("revalidate promotes a corrected working draft without spawning Claude", async (t) => {
  const fixture = await setupFailedV2Run(t);
  fs.writeFileSync(fixture.runPaths.workingDraftPath,
    `${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`, "utf8");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  fixture.config.env.runId = fixture.attemptId;

  const result = await runRevalidate(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8")).validationRevision, 2);
});

test("revalidate rejects an invalid run id before reading or spawning", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fixture.config.env.runId = "../../escape";
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  await assert.rejects(() => runRevalidate(fixture.config, fixture.meetingDate), /UUID/);
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
});

test("revalidate rejects a replacement snapshot bound to the same path", async (t) => {
  const fixture = await setupFailedV2Run(t);
  const changed = sealSnapshot({ ...fixture.snapshot, rawContent: `${HEADER}\n- 교체된 9/9 PASS\n` });
  writeJsonAtomic(fixture.snapshotPath, changed);
  fixture.config.env.runId = fixture.attemptId;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  await assert.rejects(() => runRevalidate(fixture.config, fixture.meetingDate), /snapshot hash mismatch/i);
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
});
```

Import `sealSnapshot` and `writeJsonAtomic` from `../report-artifact` in the revalidate test.

- [ ] **Step 2: Run tests and verify missing mode/API failures**

```bash
rtk node --test lib/__tests__/config-read-json.test.js lib/__tests__/report-revalidate.test.js
```

Expected: FAIL because `runId` and `runRevalidate` do not exist.

- [ ] **Step 3: Add config and mode dispatch**

Add `runId: process.env.RUN_ID || ""` next to the existing `mode` config field. Add `case "revalidate": return runRevalidate(config, meetingDate);` to `main()` and include `revalidate` in the unknown-mode help text. Keep the API-key guard exactly `env.mode === "update"`; revalidate is filesystem-only.

- [ ] **Step 4: Implement hash-bound revalidation**

```js
async function runRevalidate(config, meetingDate) {
  const meetingDateText = formatDate(meetingDate);
  const run = loadReportRun(config.env.outputDir, meetingDateText, config.env.runId);
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  const reportPath = buildOutputPath(meetingDate, config);
  const generationStatePath = buildGenerationStatePath(reportPath);
  assertGenerationStateOwned(generationStatePath, run.state.attemptId);
  assertRunInputs(run.state, snapshot, run.catalog, {
    attemptId: config.env.runId,
    meetingDate: meetingDateText,
    reportDepth: Number(config.env.reportDepth),
  });
  if (run.state.status !== "validation_failed") {
    throw new Error(`revalidate requires validation_failed state, got ${run.state.status}`);
  }
  const annotated = fs.readFileSync(run.paths.workingDraftPath, "utf8");
  const result = validateAnnotatedReport(snapshot.rawContent, annotated, run.catalog, {
    attemptId: run.state.attemptId,
    meetingDate: meetingDateText,
    reportDepth: Number(config.env.reportDepth),
    snapshotHash: snapshot.contentHash,
    snapshotPath,
    sectionHeader: config.env.sectionHeader,
    repos: config.repos,
    openIssueVerifierOptions: config.openIssueVerifierOptions,
  });
  if (isPublishable(result.validation)) {
    result.validation.cleanReportHash = sha256(result.cleanContent);
  }
  const revision = appendValidationRevision(
    run.paths,
    run.state.attemptId,
    result.validation
  );
  if (!isPublishable(result.validation)) {
    updateRunState(run.paths, run.state.attemptId, { status: "validation_failed" });
    writeGenerationStateIfOwned(generationStatePath, run.state.attemptId, {
      status: "failed",
      validationStatus: result.validation.status,
      latestValidationPath: path.basename(revision.validationPath),
    });
    return { ...result, runPaths: run.paths, reportPath };
  }
  promoteRunReport({
    paths: run.paths,
    reportPath,
    generationStatePath,
    cleanContent: result.cleanContent,
    validation: result.validation,
    generationState: {
      ...revision.state,
      status: "complete",
      cleanReportHash: result.validation.cleanReportHash,
      latestValidationPath: path.basename(revision.validationPath),
    },
  });
  return { ...result, runPaths: run.paths, reportPath };
}
```

Import `path` in `index.js` for basename-only validation pointers. Reject absent/invalid UUID, non-v2 run, snapshot/catalog hash mismatch, missing working draft, and superseded attempt. Do not import or call `aiSummarize()` in this function.

- [ ] **Step 5: Run revalidate and generate tests**

```bash
rtk node --test lib/__tests__/report-revalidate.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/config-read-json.test.js
```

Expected: all tests PASS; revalidate fake spawn marker remains absent.

- [ ] **Step 6: Commit revalidate mode**

```bash
rtk git add lib/config.js index.js lib/__tests__/helpers/report-run-fixture.js lib/__tests__/config-read-json.test.js lib/__tests__/report-revalidate.test.js
rtk git commit -m "feat(report): zero-LLM revalidate 모드 추가"
```

### Task 8: Schema v2 Update and Non-Overridable Publish Gate

**Files:**
- Create: `lib/__tests__/report-update-v2.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`
- Modify: `index.js:217-313`
- Modify: `lib/__tests__/index-modes.test.js`
- Modify: `lib/__tests__/publisher-update-content.test.js`

**Interfaces:**
- Changes compatibly: `assertGenerationComplete()` accepts schema v1 or schema v2 and returns `{state, statePath}`.
- Produces: `assertV2PublishEvidence({state, reportContent, snapshot, meetingDate, config}) -> {validation, run}`.
- Produces: `hasNonOverridableV2Issue(validation) -> boolean`.
- Produces: `buildPublishTimeValidation(evidenceValidation, publishTime) -> ValidationV2`.
- `runUpdate()` dispatches by generation-state schema; publisher still receives one immutable `draftContent` string.
- Test helper added in this task: `setupCompleteV2Run(t, options = {}) -> Promise<UpdateFixture>`; optional `rawContent`, `aiOutput`, `repos`, and `openIssueVerifierOptions` are copied into the generated fixture. It generates a valid schema v2 report, starts a localhost Redmine Wiki server, records every request, and uses report depth 2 so presentation-note Issue publishing cannot affect the gate assertion.

- [ ] **Step 1: Write failing report-hash and override tests**

```js
test("schema v2 update blocks a changed clean report before Redmine even with override", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  fs.writeFileSync(fixture.reportPath, `${HEADER}\n- changed 77건\n`, "utf8");
  fixture.config.env.validationOverride = true;
  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    /clean report hash mismatch/
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 fact errors are never validation-override eligible", () => {
  const validation = {
    schemaVersion: 2,
    status: "FAIL",
    issues: [{ severity: "error", code: "fact_value_mismatch" }],
  };
  assert.strictEqual(hasNonOverridableV2Issue(validation), true);
  assert.throws(
    () => assertPublishable(validation, { env: { validationMode: "block", validationOverride: true } }),
    /cannot be overridden/
  );
});
```

- [ ] **Step 2: Write failing publish-time open-issue recheck test**

```js
test("schema v2 update rechecks mutable open-issue evidence before Redmine", async (t) => {
  const openLine = "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)";
  const fixture = await setupCompleteV2Run(t, {
    rawContent: `${HEADER}\n${openLine}\n`,
    aiOutput: `${HEADER}\n${openLine}\n`,
    repos: { gstApp: { path: "/fixture/gstApp" } },
    openIssueVerifierOptions: {
      runGit: () => ({ ok: true, stdout: "", error: null }),
    },
  });
  fixture.config.openIssueVerifierOptions = {
    runGit: (_repoPath, args) => args.includes("-S")
      ? { ok: true, stdout: "dc06098\tchore: 빌드 디렉토리 정리\n", error: null }
      : { ok: true, stdout: "", error: null },
  };

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    /보고서 검증 WARNING/
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});
```

This proves mutable git title/pickaxe evidence is rechecked even though immutable fact evidence is hash-pinned.

- [ ] **Step 3: Run update tests and observe schema rejection/override failures**

```bash
rtk node --test lib/__tests__/report-update-v2.test.js lib/__tests__/index-modes.test.js lib/__tests__/publisher-update-content.test.js
```

Expected: FAIL because `assertGenerationComplete()` accepts only schema v1 and override still bypasses every FAIL.

- [ ] **Step 4: Implement schema-aware completion and immutable evidence checks**

```js
const NON_OVERRIDABLE_V2_CODES = new Set([
  "malformed_fact_marker",
  "unknown_fact_id",
  "fact_value_mismatch",
  "fact_subject_mismatch",
  "unmarked_protected_fact",
  "snapshot_hash_mismatch",
  "catalog_hash_mismatch",
  "clean_report_hash_mismatch",
]);

function hasNonOverridableV2Issue(validation) {
  return validation.schemaVersion === 2 && validation.issues.some(
    (issue) => NON_OVERRIDABLE_V2_CODES.has(issue.code)
  );
}
```

`assertPublishable()` calls `hasNonOverridableV2Issue()` before examining `validationOverride`. `assertV2PublishEvidence()` re-reads the global generation state from the canonical report path, requires the same complete attempt, loads the run and latest validation by a basename-only `latestValidationPath`, verifies attempt/date/depth/snapshot/catalog/working-annotated/run-clean/canonical-clean hashes, and returns the validated evidence. Hash or path failures throw before presentation-note Issue creation or any Redmine request, with one of the non-overridable codes attached to `error.code`.

- [ ] **Step 5: Split immutable fact evidence from mutable publish-time rules**

```js
if (generation.state.schemaVersion === 2) {
  const evidence = assertV2PublishEvidence({
    state: generation.state,
    reportContent,
    snapshot,
    meetingDate,
    config,
  });
  const publishTime = validateNonFactRules(reportContent, {
    meetingDate: formatDate(meetingDate),
    reportDepth: Number(config.env.reportDepth),
    snapshotHash: snapshot.contentHash,
    sectionHeader: config.env.sectionHeader,
    repos: config.repos,
    openIssueVerifierOptions: config.openIssueVerifierOptions,
  });
  const validation = buildPublishTimeValidation(evidence.validation, publishTime);
  assertPublishable(validation, config);
} else {
  const legacy = validateDraft(
    snapshot,
    snapshotPath,
    reportPath,
    meetingDate,
    config,
    { reportContent }
  );
  assertPublishable(legacy.validation, config);
}
```

`buildPublishTimeValidation()` copies the immutable attempt/snapshot/catalog/annotated/clean hashes from the successful evidence revision, replaces `issues` with `publishTime.issues`, replaces `facts.openIssueChecks` with `publishTime.openIssueChecks`, updates `checkedAt`, and computes status with the same error → warning → pass precedence. Pass the same `reportContent` to `publisher.update()`. Its `assertReady` callback calls `assertV2PublishEvidence({state: generation.state, reportContent, snapshot, meetingDate, config})` again for schema v2, or current `assertGenerationComplete()` for schema v1, immediately before note Issue creation and every Redmine PUT.

- [ ] **Step 6: Run all update and generation-gate tests**

```bash
rtk node --test lib/__tests__/report-update-v2.test.js lib/__tests__/publisher-update-content.test.js lib/__tests__/index-modes.test.js lib/__tests__/report-revalidate.test.js
```

Expected: all tests PASS; schema v1 direct-edit behavior remains compatible, while schema v2 direct edits and overrides are blocked before network access.

- [ ] **Step 7: Commit the update gate**

```bash
rtk git add index.js lib/__tests__/helpers/report-run-fixture.js lib/__tests__/report-update-v2.test.js lib/__tests__/index-modes.test.js lib/__tests__/publisher-update-content.test.js
rtk git commit -m "fix(report): schema v2 publish evidence 고정"
```

### Task 9: Operations Documentation and Full Verification

**Files:**
- Modify: `README.md:36-91`
- Modify: `docs/superpowers/specs/2026-08-26-report-fact-contract-design.md` only if implementation exposed a proven interface mismatch; do not broaden scope.

**Interfaces:**
- Documents the final `MODE=revalidate RUN_ID=<uuid> MEETING_DATE=<date>` command.
- Documents schema v1/v2 boundaries, run files, immutable/working drafts, validation revisions, and non-overridable errors.

- [ ] **Step 1: Update README with exact operator workflow**

Add content equivalent to:

```markdown
- Revalidate a failed AI run without Claude:
  `MODE=revalidate RUN_ID=<uuid> MEETING_DATE=YYYY-MM-DD ./run-report-env.sh`

AI-enabled generate stores each attempt under `out/runs/<date>/<run-id>/`.
Edit only `draft.working.annotated.md`; `draft.ai.annotated.md` is immutable.
Each revalidation appends `validation.NNN.json`. A successful run promotes a
marker-free report atomically. Do not edit a schema v2 clean report directly;
update rejects a hash mismatch before Redmine access.
```

Also state that schema v2 exact-copy facts cannot be overridden and `AI_SUMMARIZE=0` remains schema v1.

- [ ] **Step 2: Run syntax and format checks**

```bash
rtk node --check index.js
rtk node --check lib/fact-catalog.js
rtk node --check lib/annotated-draft.js
rtk node --check lib/fact-validator.js
rtk node --check lib/report-run.js
rtk node --check lib/publisher.js
rtk node --check lib/config.js
rtk git diff --check
```

Expected: every command exits 0 with no syntax or whitespace errors.

- [ ] **Step 3: Run focused hostile scenarios**

```bash
rtk node --test lib/__tests__/fact-catalog.test.js lib/__tests__/annotated-draft.test.js lib/__tests__/fact-contract-validator.test.js lib/__tests__/report-run.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js lib/__tests__/report-update-v2.test.js
```

Expected: all focused tests PASS, with no real Claude or Redmine access.

- [ ] **Step 4: Run the complete regression suite**

```bash
rtk node --test lib/__tests__/*.test.js
```

Expected: zero failures, zero cancelled tests, and zero skipped tests unless a pre-existing explicitly documented skip exists.

- [ ] **Step 5: Verify worktree scope**

```bash
rtk git status --short
rtk git diff --stat
rtk git diff --check
```

Expected: only the files listed by this plan are changed; no generated `out/` files are staged.

- [ ] **Step 6: Commit operations documentation**

```bash
rtk git add README.md docs/superpowers/specs/2026-08-26-report-fact-contract-design.md
rtk git commit -m "docs(report): fact contract 복구 절차 문서화"
```

If the spec did not require a correction during implementation, omit it from `git add`; do not create an empty spec change.

## Final Review Checklist

- [ ] Every spec goal and completion criterion maps to at least one task and automated test.
- [ ] `5/8 PASS → 10/11 PASS`, `5/8 PASS → 10건 PASS, 실패 1건`, and `16건 → 16개` all fail with source/output evidence.
- [ ] Exact marker output passes and renders marker-free Markdown.
- [ ] Claude call count is one for generate and zero for revalidate.
- [ ] A failed run cannot overwrite the last canonical report.
- [ ] Raw Claude CLI payload and every validation revision remain immutable.
- [ ] Schema v2 direct clean-report edits fail before Redmine requests.
- [ ] Schema v2 fact/hash failures remain blocked under `VALIDATION_OVERRIDE=1`.
- [ ] Schema v1 and `AI_SUMMARIZE=0` compatibility tests pass.
- [ ] Publish-time open-issue/pickaxe rules rerun against latest git state.
- [ ] Full tests, syntax checks, and `git diff --check` pass immediately before review and integration.
