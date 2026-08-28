# Inline Fact Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated prompt fact catalogs with source-positioned opaque fact references and deterministically expand them before schema v2 validation.

**Architecture:** A new pure `fact-references` module annotates catalog-backed source spans as `[[fact:ID]]` and expands known references into existing `[[fact:ID|surface]]` markers. `runGenerateV2()` builds Claude's prompt from the annotated source, records `inline_refs` in the prompt artifact, and validates only the expanded working draft; revalidate and update remain unchanged.

**Tech Stack:** Node.js CommonJS, `node:test`, existing schema v2 fact catalog and validator

**Spec:** `docs/superpowers/specs/2026-08-28-inline-fact-reference-design.md`

## Global Constraints

- Prefix every shell command with `rtk`.
- Use `apply_patch` for file edits.
- Add no dependencies.
- Preserve immutable raw AI output and existing fail-closed validation.
- Do not call real Claude, Redmine, Notion, or other network services.
- Do not push or commit without a separate explicit user request.

---

### Task 1: Pure Inline Reference Transform

**Files:**
- Create: `lib/fact-references.js`
- Create: `lib/__tests__/fact-references.test.js`

**Interfaces:**
- Consumes: catalog objects returned by `buildFactCatalog(rawContent, systemFacts)`.
- Produces: `annotateFactReferences(rawContent, catalog): string`, `expandFactReferences(content, catalog): string`, and `formatSystemFactReferences(catalog): string`.

- [ ] **Step 1: Write failing tests for source annotation and deterministic expansion**

```js
const catalog = buildFactCatalog("보드 실행 5/8 PASS\n플릿 16건 배포", [
  { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
]);
const annotated = annotateFactReferences(raw, catalog);
assert.match(annotated, /\[\[fact:T0001\]\]/);
assert.doesNotMatch(annotated, /5\/8 PASS/);
assert.strictEqual(
  expandFactReferences("결과 [[fact:T0001]]", catalog),
  "결과 [[fact:T0001|5/8 PASS]]"
);
assert.strictEqual(formatSystemFactReferences(catalog), "- meeting date: [[fact:S0001]]");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test lib/__tests__/fact-references.test.js`

Expected: FAIL because `../fact-references` does not exist.

- [ ] **Step 3: Implement minimal transforms with source integrity checks**

```js
function annotateFactReferences(rawContent, catalog) {
  const facts = catalog.facts.filter((fact) => fact.sourceLocation);
  // Verify exact source slices and non-overlap, then replace from end to start.
}

function expandFactReferences(content, catalog) {
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  return String(content).replace(/\[\[fact:([TQVS]\d{4})\]\]/g, (token, id) => {
    const fact = byId.get(id);
    return fact ? `[[fact:${id}|${fact.raw}]]` : token;
  });
}
```

Throw errors with codes `FACT_SOURCE_MISMATCH` and `FACT_SOURCE_OVERLAP`. Preserve unknown references so the existing parser fails closed.

- [ ] **Step 4: Add duplicate, mismatch, overlap, and unknown-reference coverage**

Use two `3건` source lines to prove distinct `Q0001`/`Q0002` placement. Build explicit malformed catalog fixtures for mismatch and overlap. Assert an unknown `[[fact:Q9999]]` survives expansion unchanged.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `rtk node --test lib/__tests__/fact-references.test.js`

Expected: all tests PASS with no warnings.

### Task 2: Inline Reference Prompt Contract

**Files:**
- Modify: `lib/publisher.js:3,283-381`
- Modify: `lib/__tests__/publisher-ai-budget.test.js:45-130`

**Interfaces:**
- Consumes: `options.factInputMode === "inline_refs"`, an already annotated `rawContent`, and `options.factCatalog`.
- Produces: a compact prompt that includes inline-reference rules and system references but excludes the full sourceExcerpt catalog.

- [ ] **Step 1: Write a failing prompt test**

```js
const raw = "보드 실행 5/8 PASS";
const catalog = buildFactCatalog(raw, [
  { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
]);
const source = annotateFactReferences(raw, catalog);
const prompt = buildAiPrompt(source, config, meetingDate, {
  factCatalog: catalog,
  factInputMode: "inline_refs",
});
assert.match(prompt, /\[\[fact:T0001\]\]/);
assert.match(prompt, /meeting date: \[\[fact:S0001\]\]/);
assert.doesNotMatch(prompt, /\[\[fact:T0001\|5\/8 PASS\]\]/);
assert.doesNotMatch(prompt, /— 보드 실행 5\/8 PASS/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test lib/__tests__/publisher-ai-budget.test.js`

Expected: FAIL because `buildAiPrompt()` still emits the full ready-to-copy catalog.

- [ ] **Step 3: Implement compact inline-reference guidance**

Keep the legacy full-marker guidance for callers without `factInputMode`. For `inline_refs`, explain that protected facts are opaque references already embedded at their source positions, require exact token copying, forbid adjacent unit/counter additions, and list only `sourceLocation: null` system facts. Replace the literal as-of meeting date with its `S` reference.

- [ ] **Step 4: Run prompt and publisher tests and verify GREEN**

Run: `rtk node --test lib/__tests__/publisher-ai-budget.test.js lib/__tests__/fact-references.test.js`

Expected: all tests PASS and no fake Claude process is started by input-limit tests.

### Task 3: Generate Pipeline Expansion and Artifact Evidence

**Files:**
- Modify: `index.js:287-390`
- Modify: `lib/__tests__/report-generate-v2.test.js:14-95`

**Interfaces:**
- Consumes: `annotateFactReferences()` before prompt construction and `expandFactReferences()` after `generateContent()` sanitizes the AI output.
- Produces: bare references in immutable AI output, full markers in working draft, clean facts in canonical report, and `factInputMode: "inline_refs"` in `prompt-input.json`.

- [ ] **Step 1: Change the successful integration fixture to emit a bare reference**

```js
const aiOutput = `설명 머리말\n${HEADER}\n- 보드 실행 [[fact:T0001]]\n`;
```

Assert that `draft.ai.annotated.md` equals this raw response, `draft.working.annotated.md` contains `[[fact:T0001|5/8 PASS]]`, the canonical report contains `5/8 PASS` without markers, and `promptInput.factInputMode === "inline_refs"`.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `rtk node --test lib/__tests__/report-generate-v2.test.js`

Expected: FAIL with `malformed_fact_marker` because bare references are not expanded yet.

- [ ] **Step 3: Wire annotation and expansion into `runGenerateV2()`**

```js
const aiSource = annotateFactReferences(snapshot.rawContent, catalog);
const prompt = buildAiPrompt(aiSource, config, meetingDate, {
  factCatalog: catalog,
  factInputMode: "inline_refs",
});
const generated = await generateContent(config, meetingDate, aiSource, { /* same options */ });
const workingContent = expandFactReferences(generated.content, catalog);
```

Write `workingContent` to the working artifact, hash it as the sanitizer output, and pass it to `validateAnnotatedReport()`. Add `factInputMode` to the immutable prompt metadata.

- [ ] **Step 4: Add fail-closed integration coverage**

Have fake Claude return an unknown bare reference and assert validation FAIL with `malformed_fact_marker`. Have it return `[[fact:Q0001]]개` for source `4 repos` and assert the expanded working draft is rejected by `unmarked_protected_fact`.

- [ ] **Step 5: Run generate/revalidate tests and verify GREEN**

Run: `rtk node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js`

Expected: all tests PASS; revalidate starts no Claude process.

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-26-report-fact-contract-design.md`

**Interfaces:**
- Consumes: the final artifact and prompt behavior from Tasks 1-3.
- Produces: operator guidance that distinguishes raw bare-reference AI drafts from editable full-marker working drafts.

- [ ] **Step 1: Update operator documentation**

Document that schema v2 prompt input uses inline bare references, `draft.ai.annotated.md` may contain them, only `draft.working.annotated.md` is manually edited, and revalidate still performs zero AI calls. Add an amendment link from the original fact-contract design to the 2026-08-28 design.

- [ ] **Step 2: Run focused and full tests**

Run: `rtk node --test lib/__tests__/fact-references.test.js lib/__tests__/publisher-ai-budget.test.js lib/__tests__/report-generate-v2.test.js lib/__tests__/report-revalidate.test.js`

Run: `rtk node --test lib/__tests__/*.test.js`

Expected: all tests PASS with no failures or warnings.

- [ ] **Step 3: Verify syntax, diff hygiene, and worktree scope**

Run: `rtk node --check lib/fact-references.js`

Run: `rtk node --check lib/publisher.js`

Run: `rtk node --check index.js`

Run: `rtk git diff --check`

Run: `rtk git status --short`

Expected: syntax checks and diff check exit 0; only the planned source, test, and documentation files are modified or added.

- [ ] **Step 4: Prepare handoff without external side effects**

Report measured prompt length using the sealed 2026-08-26 snapshot without invoking Claude. Do not run a real pilot, publish, push, or commit until the user explicitly authorizes the corresponding action.

Execution evidence (2026-08-28): snapshot content hash `676dd2e0083bf8fb50057c06d71cf4101344b7cf0aa13064af49f4854e82b35c`; 377 facts; prompt `88,836 → 59,844` chars (`-28,992`, `-32.64%`); 378 bare references and zero full markers; no Claude invocation.
