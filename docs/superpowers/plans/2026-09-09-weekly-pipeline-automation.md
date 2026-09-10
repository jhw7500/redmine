# Weekly Report Pipeline Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매주 수요일 주간보고를 원문 선택 방식으로 준비하고, 같은 회의일의 검증된 READY 증거만 06:45에 자동 게시하며, 실패 원인을 로그와 불변 산출물에 남기는 2단계 운영 자동화를 완성한다.

**Architecture:** 기존 `collect -> schema v2 generate -> update` 구현은 재사용하되 새 `lib/weekly-pipeline.js`가 회의일별 파이프라인 상태, 증거 결속, 실패 분류·보존을 담당한다. `weekly-prepare`는 수집과 생성을 한 실행에서 묶고, `weekly-publish`는 READY 증거를 다시 검증한 후 `lib/publisher.js`의 PUT 직전 콜백으로 기대 섹션 hash를 고정하며 PUT 후 GET 결과를 비교한다. 저장소 래퍼가 운영 프로필을 고정하고 crontab은 준비/게시 두 항목만 호출한다.

**Tech Stack:** Node.js CommonJS, built-in `node:test`/`node:assert`, Bash, Redmine Wiki JSON API, 기존 `flock` 실행 잠금. 신규 npm 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-09-weekly-pipeline-automation-design.md`

## Global Constraints

- 모든 shell 명령은 `/home/jhw/.codex/RTK.md`에 따라 `rtk`로 시작한다.
- 소스·테스트·문서 변경은 `apply_patch`로 수행한다.
- 엄격한 TDD 순서를 지킨다: 행동 테스트 작성, 해당 이유로 RED 확인, 최소 구현, GREEN 확인.
- 기존 수동 `collect`, `generate`, `revalidate`, `update`, `prune` 동작과 일반 기본값 `AI_GENERATION_METHOD=freeform`은 유지한다.
- 주간 준비 프로필은 `AI_SUMMARIZE=1`, `AI_PROVIDER=codex`, `AI_MODEL=gpt-5.6-sol`, `AI_EFFORT=low`, `AI_GENERATION_METHOD=source_selection`, `AI_GENERATION_SCOPE=whole`, `SOURCE_SELECTION_FALLBACK=1`, `REPORT_DEPTH=3`, `VALIDATION_MODE=block`, `PRESENTATION_NOTE_MODE=suggest`를 강제한다.
- `MEETING_DATE`, `OUTPUT_DIR`, `SNAPSHOT_PATH`는 수동 복구·격리 실행에서 명시한 값을 보존한다. `.env`가 주간 운영 프로필을 다시 덮어쓰지 못하게 한다.
- 검증 실패 보고서는 canonical report로 승격하지 않지만 기존 immutable run 산출물과 새 failure JSON/Markdown을 모두 남긴다.
- READY가 아니면 Wiki PUT과 발표노트 Issue 쓰기를 포함한 Redmine 변경 요청을 시작하지 않는다.
- `failed`와 `published` 상태의 게시 재실행은 exit 0, 알림 없음, Redmine 요청 0건인 멱등 skip이다.
- PUT 성공 뒤 GET 검증 실패는 자동 rollback 또는 자동 재게시하지 않고 `serverState=written_unverified`로 기록한다.
- 오류 산출물에는 API key, Authorization 값, URL credential, token 형태, HTTP 원문 body를 복사하지 않는다.
- 테스트는 실제 Codex, Notion, Redmine, GitHub 네트워크를 호출하지 않는다.
- 보고서에 open-status 문구를 추가하는 변경이 생기면 `AGENTS.md`의 git subject와 pickaxe 2단계 검증을 먼저 수행하고 as-of 날짜 또는 해결 커밋을 기록한다.
- PR 전 tribunal 보고서는 reviewer 응답 byte를 그대로 보존하고, 각 파일을 현재 사용자 소유의 non-symlink regular file 및 mode `0600`으로 확인한 뒤에만 finalize한다.
- GitHub 리뷰 요청은 사용자가 지정한 Codex와 Gemini만 사용한다. Claude 리뷰 요청은 만들지 않는다.
- 운영 crontab 변경 전 현재 내용을 timestamp 백업하고, 다른 항목은 byte 단위로 유지하며 기존 세 줄 제거와 새 두 줄 단일 등록을 재조회로 검증한다.
- 현재 주 보고서는 이미 게시됐으므로 rollout 중 실제 Redmine Wiki 재게시를 smoke test로 사용하지 않는다.

## File Map

- Create `lib/weekly-pipeline.js`: durable state, legal transitions, READY evidence path checks, failure classification/redaction/artifacts, compact log rendering.
- Create `lib/__tests__/weekly-pipeline.test.js`: pure state/failure/prepare/publish unit and fake Redmine integration tests.
- Modify `index.js`: `runWeeklyPrepare`, `runWeeklyPublish`, CLI mode dispatch, dependency seams, post-PUT section verification.
- Modify `lib/publisher.js`: PUT 직전 callback, PUT 후 GET, structured publication result, remote section extraction export.
- Modify `lib/__tests__/publisher-update-content.test.js`: mutable fake Wiki and PUT/GET ordering/result coverage.
- Modify `lib/__tests__/helpers/report-run-fixture.js`: PUT payload를 서버 상태에 반영하고 post-PUT GET metadata 제공.
- Modify `lib/__tests__/report-update-v2.test.js`: post-PUT GET request counts and structured result expectations.
- Create `run-weekly-prepare-env.sh`: weekly prepare profile entry point.
- Create `run-weekly-publish-env.sh`: weekly publish profile entry point.
- Modify `run-report-env.sh`: `.env` 로드 뒤 승인된 weekly profile 적용 및 기존 단일 실패 알림 재사용.
- Modify `lib/__tests__/run-report-env.test.js`: 두 weekly wrapper의 checkout-relative 실행과 exact env contract 검증.
- Modify `README.md`: two-stage schedule, state/failure artifacts, recovery commands, server-write meaning.
- Modify `docs/superpowers/specs/2026-09-09-weekly-pipeline-automation-design.md`: implementation-discovered `reportDepth` and already-published idempotency fields.

---

### Task 1: Durable weekly state machine and path ownership

**Files:**

- Create: `lib/weekly-pipeline.js`
- Create: `lib/__tests__/weekly-pipeline.test.js`

**Interfaces:**

```js
buildWeeklyPipelinePaths(outputDir, meetingDate) -> {
  meetingDir, statusPath, failuresDir
}
createWeeklyAttempt({ outputDir, meetingDate, reportDepth, attemptId, now }) -> state
loadWeeklyStatus(outputDir, meetingDate) -> state | null
patchWeeklyStatus(paths, expectedAttemptId, patch) -> state
markWeeklyReady(paths, expectedAttemptId, evidence) -> state
markWeeklyPublishing(paths, expectedAttemptId, expectedSectionHash) -> state
markWeeklyPublished(paths, expectedAttemptId, published) -> state
```

State transition table implemented in code:

```js
const TRANSITIONS = {
  preparing: new Set(["ready", "failed"]),
  ready: new Set(["publishing", "failed"]),
  publishing: new Set(["published", "failed"]),
};
```

- [ ] **Step 1: Write state creation and transition tests**

Cover exact meeting path, UUID ownership, `schemaVersion=1`, `reportDepth=3`, timestamps, and legal transitions. Assert that a second `createWeeklyAttempt` intentionally replaces only `status.json` with a new attempt while leaving the meeting directory intact.

```js
test("weekly state follows preparing to ready to publishing to published", () => {
  const state = createWeeklyAttempt({
    outputDir, meetingDate: "2026-09-16", reportDepth: 3,
    attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z",
  });
  assert.equal(state.status, "preparing");
  const ready = markWeeklyReady(paths, ATTEMPT_ID, evidence);
  assert.equal(ready.status, "ready");
  assert.equal(markWeeklyPublishing(paths, ATTEMPT_ID, SECTION_HASH).status, "publishing");
});

test("weekly state rejects stale ownership and illegal transitions", () => {
  assert.throws(() => patchWeeklyStatus(paths, OTHER_ID, { stage: "generate" }), /ownership/);
  assert.throws(() => markWeeklyPublished(paths, ATTEMPT_ID, published), /invalid.*transition/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk node --test lib/__tests__/weekly-pipeline.test.js
```

Expected: FAIL because `../weekly-pipeline` does not exist.

- [ ] **Step 3: Implement path building, state schema, and transitions**

Use `path.resolve(outputDir, "pipeline", meetingDate)` and require `YYYY-MM-DD`. Ensure the resolved meeting directory is exactly one child of the resolved pipeline root. State patches may update `stage` without a status transition, but an explicit `status` must follow the table and retain the original `pipelineAttemptId`.

Required READY state fields are:

```js
{
  snapshotPath, snapshotHash,
  generationAttemptId, generationStatePath,
  reportPath, reportHash,
  expectedSectionHash: null,
  published: null,
}
```

- [ ] **Step 4: Add durable atomic-write tests**

Inject or expose the narrow writer and verify:

- temp file is opened with `wx`;
- file descriptor is `fsync`ed before close;
- rename replaces `status.json` only after the complete JSON exists;
- containing directory is `fsync`ed after rename;
- interrupted writer simulation leaves the previous valid `status.json` readable;
- a symlink `status.json` or symlinked pipeline directory is rejected.

- [ ] **Step 5: Implement durable state writes**

Implement a private `writeJsonDurableAtomic(filePath, value)` using a random temp filename, `openSync(..., "wx", 0o600)`, `writeFileSync`, `fsyncSync`, `closeSync`, `renameSync`, and directory `fsyncSync`. Reject an existing status target when `lstatSync(...).isSymbolicLink()` and reject realpath escape from the configured output directory.

- [ ] **Step 6: Run Task 1 tests and commit**

```bash
rtk node --test lib/__tests__/weekly-pipeline.test.js
rtk git diff --check
rtk git add lib/weekly-pipeline.js lib/__tests__/weekly-pipeline.test.js
rtk git commit -m "feat(report): add durable weekly pipeline state"
```

Expected: focused tests PASS; no whitespace errors.

---

### Task 2: Immutable, actionable failure evidence

**Files:**

- Modify: `lib/weekly-pipeline.js`
- Modify: `lib/__tests__/weekly-pipeline.test.js`

**Interfaces:**

```js
classifyWeeklyFailure({ stage, error, validation }) -> {
  code, primaryIssueCode, cause, issueCounts, representativeIssues
}
recordWeeklyFailure({ paths, state, stage, error, validation,
  artifacts, redmineWriteAttempted, serverState, retryCommand, now }) -> {
  state, jsonPath, markdownPath, failure
}
formatWeeklyFailureLog(failure, markdownPath) -> string
formatWeeklySkipLog(state) -> string
```

- [ ] **Step 1: Write classification and redaction tests**

Use table-driven cases:

| Stage/input | Stable `code` | Log `primaryIssueCode` |
|---|---|---|
| collect exception | `collect_failed` | exception code or `collect_failed` |
| `AI_*` exception | `ai_failed` | exact AI code |
| `SOURCE_SELECTION_*` or `SOURCE_RECORDS_*` | `source_selection_invalid` | exact source-selection code |
| non-publishable validation | `validation_failed` | highest-frequency then lexical issue code |
| missing/preparing status | `prepare_incomplete` | `prepare_incomplete` |
| READY ownership/hash mismatch | `ready_evidence_mismatch` | underlying evidence code |
| Wiki HTTP exception | `publish_http_failed` | HTTP/error code |
| stale `publishing` | `publish_incomplete` | `publish_incomplete` |
| remote section mismatch | `publish_verify_mismatch` | `publish_verify_mismatch` |

Test validation aggregation with `unmarked_protected_fact` repeated twice and another error once. Assert the log is one line and uses the primary detail code:

```js
assert.match(log, /^\[weekly\]\[FAIL\] stage=validate code=unmarked_protected_fact /);
assert.match(log, /artifact=.*\.md$/);
```

Feed messages containing `X-Redmine-API-Key`, `Authorization: Bearer`, `xoxb-...`, `secret@host`, and a very long body. Assert JSON, Markdown, and log contain `[REDACTED]`, omit the secrets, and cap message/stack/representative issue lengths.

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because failure APIs are not exported.

- [ ] **Step 3: Implement deterministic classification and redaction**

Keep the stable pipeline code in `failure.code`; preserve original model/validator detail in `primaryIssueCode`, `issueCounts`, and at most three representative issues. Map errors by execution stage first, then by exact/prefix code. Do not serialize arbitrary error properties, request headers, or response bodies.

Artifact discovery receives an allowlisted list of candidate paths; retain only existing non-symlink regular files inside `outputDir`. Store absolute paths and their SHA-256, never file contents.

- [ ] **Step 4: Write immutable artifact and retry guidance tests**

Assert both files use:

```text
out/pipeline/2026-09-16/failures/<timestamp>-<stage>-<attempt>.json
out/pipeline/2026-09-16/failures/<timestamp>-<stage>-<attempt>.md
```

The Markdown order must be: stage/cause, issue counts/examples, server state, artifact paths, exact retry command. Reusing the same destination must throw rather than overwrite. A second pipeline attempt must create new files and preserve the first pair.

- [ ] **Step 5: Implement immutable failure writes and failed transition**

Use existing `writeImmutableArtifact()` for final JSON/Markdown names. After both writes succeed, transition `preparing`, `ready`, or `publishing` to `failed` and set `failureArtifact` to the Markdown path. If status persistence fails, keep the immutable failure files and throw the persistence error with their paths attached.

- [ ] **Step 6: Run Task 2 tests and commit**

```bash
rtk node --test lib/__tests__/weekly-pipeline.test.js
rtk git diff --check
rtk git add lib/weekly-pipeline.js lib/__tests__/weekly-pipeline.test.js
rtk git commit -m "feat(report): preserve weekly failure evidence"
```

---

### Task 3: Publisher returns post-write server evidence

**Files:**

- Modify: `lib/publisher.js`
- Modify: `lib/__tests__/publisher-update-content.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`
- Modify: `lib/__tests__/report-update-v2.test.js`

**Interface extension:**

```js
update(config, meetingDate, {
  ...existingOptions,
  onBeforePut: async ({ finalSection, pageUrl, wikiTitle }) => {},
}) -> {
  changed,
  finalSection,
  publishedPath,
  pageUrl,
  wikiTitle,
  remote: { section, version, updatedOn, fetchedAt }
}
```

- [ ] **Step 1: Make fake Wiki servers stateful and add a failing result test**

Update `startWikiServer()` and `attachWikiServer()` so a successful PUT parses `payload.wiki_page.text`, updates the in-memory page text/version, and the next GET returns that state. Add a test proving the call order and exact remote section:

```js
const result = await update(config, meetingDate, {
  draftContent,
  onBeforePut: ({ finalSection }) => events.push(["BEFORE_PUT", finalSection]),
});
assert.deepStrictEqual(events.map(([name]) => name), ["BEFORE_PUT"]);
assert.equal(result.remote.section, result.finalSection.trimEnd() + "\n");
assert.equal(result.remote.version, 2);
```

Expected RED: `onBeforePut` is ignored and `remote` is absent.

- [ ] **Step 2: Implement one pre-PUT callback and mandatory post-PUT GET**

Export `extractSection`. Invoke `onBeforePut` after the final `assertReady(finalSection)` and immediately before the first PUT attempt. Guard it with a boolean so 409 retries do not repeat the state transition. After PUT success, GET the same `pageUrl`, require string `wiki_page.text`, extract the configured section, then return structured metadata.

If the post-PUT GET throws or lacks a target section, attach only these safe fields to the thrown error:

```js
error.redmineWriteAttempted = true;
error.serverState = "written_unverified";
error.stage = "publish_verify";
```

Do not claim the write was absent. Save `publishedPath` only after a parseable post-PUT GET exists; the pipeline still decides whether the remote section matches.

- [ ] **Step 3: Preserve no-change behavior with structured evidence**

When the fresh server page already contains the exact `finalSection`, return `changed:false` with the same `remote` shape instead of `undefined`. Do not invoke PUT. Manual approval cancellation remains `undefined` and weekly mode never reaches it because `AUTO_APPROVE=1` is required.

- [ ] **Step 4: Update exact ordering and request-count expectations**

The 409 test now has one additional final GET after the successful PUT. Update only successful publish counts; every pre-write evidence failure must still assert PUT count 0, and cases where `assertReady` fails before the initial GET must remain total request count 0.

- [ ] **Step 5: Run publisher/update tests and commit**

```bash
rtk node --test \
  lib/__tests__/publisher-update-content.test.js \
  lib/__tests__/report-update-v2.test.js
rtk git diff --check
rtk git add lib/publisher.js lib/__tests__/publisher-update-content.test.js \
  lib/__tests__/helpers/report-run-fixture.js lib/__tests__/report-update-v2.test.js
rtk git commit -m "feat(report): return verified Wiki write evidence"
```

---

### Task 4: `weekly-prepare` orchestration and READY binding

**Files:**

- Modify: `index.js`
- Modify: `lib/__tests__/weekly-pipeline.test.js`
- Modify: `lib/__tests__/index-modes.test.js`

**Interfaces:**

```js
assertWeeklyProfile(config, mode) -> void
runWeeklyPrepare(config, meetingDate, dependencies = {}) -> {
  state, collectResult, generationResult
}
```

Dependency defaults are the existing `runCollect` and `runGenerate`; tests inject fakes without spawning a provider or touching network.

- [ ] **Step 1: Write a failing happy-path prepare test**

Arrange a sealed collection result and a schema-v2 source-selection generation result. Assert call order `collect -> generate`, the same `meetingDate`/`config` object, and READY fields bound to actual file bytes:

```js
assert.equal(state.status, "ready");
assert.equal(state.snapshotHash, collectResult.snapshot.contentHash);
assert.equal(state.generationAttemptId, generationState.attemptId);
assert.equal(state.reportHash, sha256(fs.readFileSync(reportPath, "utf8")));
assert.equal(state.expectedSectionHash, null);
```

Also call existing `assertV2PublishEvidence()` before READY and require `generationMethod=source_selection`, schema v2 complete state, report depth 3, and publishable latest validation.

- [ ] **Step 2: Run focused prepare tests and verify RED**

Expected: FAIL because `runWeeklyPrepare` is absent.

- [ ] **Step 3: Implement profile validation and prepare orchestration**

Create the attempt before collection. Update `stage` before each operation. On success use real state/report bytes rather than trusting returned hash fields. READY evidence includes absolute, contained, non-symlink regular paths for snapshot, generation state, and report.

If another generation supersedes the attempt, or any evidence changes between validation and `markWeeklyReady`, record `ready_evidence_mismatch` and fail. Do not silently retry with freeform generation or `VALIDATION_OVERRIDE`.

- [ ] **Step 4: Add stage-specific failure tests**

Cover:

- collection exception and partial snapshot -> `collect_failed`;
- `AI_TIMEOUT`, `AI_EXIT`, `AI_EMPTY_OUTPUT`, `AI_SPAWN` -> `ai_failed`;
- `SOURCE_SELECTION_INVALID`/`SOURCE_RECORDS_INVALID` -> `source_selection_invalid`;
- returned non-publishable validation -> `validation_failed` with rejected report and validation paths;
- missing/changed generation state or report after generation -> `ready_evidence_mismatch`.

Each case must assert one failure JSON, one Markdown, a single `[weekly][FAIL]` log line, canonical report preservation when one existed, and no Redmine requests.

- [ ] **Step 5: Wire CLI mode without changing generic mode exits**

Add `weekly-prepare` to `main()` and exports:

```js
case "weekly-prepare": {
  return runWeeklyPrepare(config, meetingDate);
}
```

The orchestrator throws after recording a failed prepare so `run-report-env.sh` produces exactly one existing alert. It must not rely on `main()`'s generic generate `process.exitCode=2` path.

- [ ] **Step 6: Run prepare/mode tests and commit**

```bash
rtk node --test \
  lib/__tests__/weekly-pipeline.test.js \
  lib/__tests__/index-modes.test.js \
  lib/__tests__/source-selection-run.test.js
rtk git diff --check
rtk git add index.js lib/__tests__/weekly-pipeline.test.js lib/__tests__/index-modes.test.js
rtk git commit -m "feat(report): prepare validated weekly reports"
```

---

### Task 5: `weekly-publish` gate, write boundary, and exact verification

**Files:**

- Modify: `index.js`
- Modify: `lib/weekly-pipeline.js`
- Modify: `lib/__tests__/weekly-pipeline.test.js`

**Interface:**

```js
runWeeklyPublish(config, meetingDate, dependencies = {}) -> {
  skipped, reason, state, updateResult
}
```

- [ ] **Step 1: Write the state decision table as tests**

Use one subtest per state and a spy `runUpdate`:

| Input | Result | Exit semantics | Update calls |
|---|---|---|---:|
| `failed` | skip with prior failure path | resolve | 0 |
| `published` | `already-published` skip | resolve | 0 |
| no status | record `prepare_incomplete` | reject | 0 |
| stale `preparing` | record `prepare_incomplete` | reject | 0 |
| stale `publishing` | record `publish_incomplete` | reject | 0 |
| `ready` with mismatched meeting/depth/path/hash/attempt | `ready_evidence_mismatch` | reject | 0 |
| valid `ready` | continue | resolve only after verify | 1 |

For `failed`/`published`, capture console output and require one `[weekly][SKIP]` line, no new failure artifact, and no thrown error so the wrapper sends no duplicate alert.

- [ ] **Step 2: Run focused publish tests and verify RED**

Expected: FAIL because `runWeeklyPublish` is absent.

- [ ] **Step 3: Implement READY revalidation before any external work**

Load status by formatted meeting date. Resolve each evidence path through `realpath`, require non-symlink regular files within `config.env.outputDir`, recompute snapshot/report hashes, reload generation state, and call existing `assertV2PublishEvidence()` against the exact `generationAttemptId`. Require depth 3 and `generationMethod=source_selection` in both pipeline and generation evidence.

The dependency injection boundary is:

```js
const publish = dependencies.runUpdate || runUpdate;
const updateResult = await publish(config, meetingDate, {
  onBeforePut: ({ finalSection }) => {
    const expected = sha256(normalizeSection(finalSection));
    markWeeklyPublishing(paths, state.pipelineAttemptId, expected);
  },
});
```

Extend `runUpdate(config, meetingDate, options = {})` to forward `onBeforePut` into `publisher.update` and return the publisher result as `publication`; all existing callers remain valid.

- [ ] **Step 4: Write and implement exact post-PUT verification**

Normalize both strings as `String(value).trimEnd() + "\n"`. Require:

```js
sha256(normalizeSection(updateResult.publication.finalSection)) === publishing.expectedSectionHash
normalizeSection(updateResult.publication.remote.section) === normalizeSection(updateResult.publication.finalSection)
```

On equality, mark `published` with `wikiTitle`, remote `version`, `updatedOn`, expected `sectionHash`, and `verifiedAt`. On successful GET but mismatch, record `publish_verify_mismatch`, `redmineWriteAttempted=true`, `serverState=written_unverified`, and reject without rollback.

- [ ] **Step 5: Cover HTTP and interrupted publishing failures**

If `runUpdate` fails before `onBeforePut`, record `publish_http_failed` with `redmineWriteAttempted=false`, `serverState=unchanged`. If it fails after `onBeforePut`, use error metadata from Task 3 and record `redmineWriteAttempted=true`, `serverState=written_unverified`. A later cron/manual `weekly-publish` seeing `publishing` records `publish_incomplete` and never blindly calls `runUpdate` again.

- [ ] **Step 6: Add full fake-Redmine integration tests**

Generate a complete v2 fixture, mark READY, run weekly publish against the stateful fake Wiki, then assert request sequence ends in `PUT, GET`, remote other-person section is unchanged, local `.published.md` matches, and final status is `published` with the remote version/hash.

Add mismatch and post-PUT GET 500 cases. Both must leave the fake server's written text visible to the test and final pipeline state `failed` with `written_unverified` evidence.

- [ ] **Step 7: Wire CLI mode and commit**

```bash
rtk node --test \
  lib/__tests__/weekly-pipeline.test.js \
  lib/__tests__/publisher-update-content.test.js \
  lib/__tests__/report-update-v2.test.js \
  lib/__tests__/index-modes.test.js
rtk git diff --check
rtk git add index.js lib/weekly-pipeline.js lib/__tests__/weekly-pipeline.test.js
rtk git commit -m "feat(report): publish only matching weekly READY evidence"
```

---

### Task 6: Versioned weekly wrappers and single-alert cron semantics

**Files:**

- Create: `run-weekly-prepare-env.sh`
- Create: `run-weekly-publish-env.sh`
- Modify: `run-report-env.sh`
- Modify: `lib/__tests__/run-report-env.test.js`

- [ ] **Step 1: Add failing wrapper contract tests**

Extend the fake `bash` capture to record the fixed profile plus recovery variables. Test hostile inherited values and conflicting `.env` values. Expected weekly prepare values:

```js
{
  mode: "weekly-prepare",
  aiSummarize: "1",
  aiProvider: "codex",
  aiModel: "gpt-5.6-sol",
  aiEffort: "low",
  aiGenerationMethod: "source_selection",
  aiGenerationScope: "whole",
  sourceSelectionFallback: "1",
  reportDepth: "3",
  validationMode: "block",
  presentationNoteMode: "suggest",
}
```

Publish additionally requires `AUTO_APPROVE=1`. Confirm both wrappers exec their own checkout's `run-report-env.sh`, and `MEETING_DATE`, `OUTPUT_DIR`, `SNAPSHOT_PATH` supplied by the caller survive.

- [ ] **Step 2: Run wrapper tests and verify RED**

```bash
rtk node --test lib/__tests__/run-report-env.test.js
```

Expected: FAIL because weekly wrappers do not exist.

- [ ] **Step 3: Implement explicit profile selection after `.env` load**

Each weekly wrapper exports only its mode plus a private profile selector such as `REDMINE_WEEKLY_PROFILE=prepare|publish`, then execs `run-report-env.sh`. In `run-report-env.sh`, capture the requested mode/profile and recovery path/date values before sourcing `.env`; restore allowed recovery values and apply the exact fixed profile afterward. Reject an unknown profile with exit 64.

Keep the existing lock path and one nonzero-exit alert block unchanged. Because `weekly-publish` resolves for prior `failed`/`published`, those cases do not enter the alert block. Missing/incomplete READY rejects once and therefore enters it exactly once.

- [ ] **Step 4: Add wrapper failure/skip integration checks**

Use temporary `OUTPUT_DIR` and fake binaries to assert:

- prepare nonzero creates one `ALERT.log` line, not two;
- failed prepare status followed by publish wrapper returns 0 and adds no alert;
- missing status publish returns nonzero and adds exactly one alert;
- both commands still run under `out/report-run.lock` through `scripts/run-with-lock.sh`.

- [ ] **Step 5: Run shell syntax and wrapper tests, then commit**

```bash
rtk bash -n run-report-env.sh run-weekly-prepare-env.sh run-weekly-publish-env.sh
rtk node --test lib/__tests__/run-report-env.test.js lib/__tests__/weekly-pipeline.test.js
rtk git diff --check
rtk git add run-report-env.sh run-weekly-prepare-env.sh run-weekly-publish-env.sh \
  lib/__tests__/run-report-env.test.js
rtk git commit -m "feat(report): add weekly cron entry points"
```

---

### Task 7: Operator documentation and incident replay acceptance

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-09-weekly-pipeline-automation-design.md`
- Modify: `docs/superpowers/plans/2026-09-09-weekly-pipeline-automation.md`

- [x] **Step 1: Document exact operation and recovery contract**

Add the two cron lines, state locations, failure artifact fields, `[weekly][FAIL]`/`[weekly][SKIP]` meanings, and these recovery commands:

```bash
rtk env MEETING_DATE=2026-09-16 ./run-weekly-prepare-env.sh
rtk env MEETING_DATE=2026-09-16 ./run-weekly-publish-env.sh
```

State explicitly that a stale `publishing` state needs server inspection and a new prepare attempt; it is never auto-republished. Explain that validation failure retains rejected/working/provider outputs but does not modify Redmine.

- [x] **Step 2: Validate the no-network deterministic 2026-09-09 artifact set**

Use the canonical sealed 2026-09-09 snapshot and stored prior draft for a fresh general replay in a new isolated directory. Because no saved snapshot contains every incident fact, use the no-I/O exact-string validator for the version range and the latest saved v5 sealed snapshot plus its complete schema-v2 source-selection run for the corrected dual-wide detail. Require depth 3, source-selection evidence, publishable validation, zero blocking issues, and preservation across that evidence split of:

- `wpa_supplicant 2.12-rc1/2.12` as a version range rather than ratio;
- dual-wide 120p cause as same exposure time with different AE settings;
- cause, fix, and verification detail in the selected source content.

Record that no single historical sealed artifact proves both incident fixes; do not edit or synthesize a sealed input to make the criterion appear atomic.

Record exact command, input artifact hashes, output run path, report hash, validation status, and blocker count in the plan Execution Notes. Do not call Redmine.

- [x] **Step 3: Test Node 22 and Node 24 full suites**

```bash
rtk /home/jhw/.nvm/versions/node/v22.23.1/bin/node \
  --test --test-reporter=dot lib/__tests__/*.test.js
rtk /home/jhw/.nvm/versions/node/v24.12.0/bin/node \
  --test --test-reporter=dot lib/__tests__/*.test.js
rtk git diff --check
```

Expected: 0 failed tests on both runtimes and no whitespace errors. Save concise pass/fail summaries and full logs outside the repository or under ignored `out/`.

- [x] **Step 4: Audit plan/spec coverage and placeholders**

Check every numbered spec acceptance criterion against at least one named test or rollout check. Run:

```bash
rtk rg -n -e 'T''BD' -e 'T''ODO' -e 'F''IXME' \
  -e 'fill ''this' -e 'add ''handling' -e 'as ''needed' \
  docs/superpowers/plans/2026-09-09-weekly-pipeline-automation.md \
  docs/superpowers/specs/2026-09-09-weekly-pipeline-automation-design.md
```

Expected: no unresolved placeholder. Update the plan checkboxes and Execution Notes with actual evidence only; never pre-mark a step complete.

- [x] **Step 5: Commit documentation and acceptance evidence**

```bash
rtk git add README.md \
  docs/superpowers/specs/2026-09-09-weekly-pipeline-automation-design.md \
  docs/superpowers/plans/2026-09-09-weekly-pipeline-automation.md
rtk git commit -m "docs(report): document weekly pipeline operations"
```

---

### Task 8: Adversarial review, PR, and safe cron rollout

**Files/External state:**

- Review artifacts: `.review/` with repository-required ownership/type/mode guarantees.
- GitHub: the existing `fix/source-selection-version-range` branch and one `main` PR.
- User crontab: replace only the three old Redmine weekly-report entries.
- Backup: `out/crontab-backups/crontab-<timestamp>.txt`.

- [ ] **Step 1: Run local adversarial review before PR mutation**

Invoke the repository's `pre-pr-tribunal` workflow. Before finalize, verify each reviewer report independently with `lstat`, current UID ownership, regular-file type, no symlink, and mode `0600`; stop before finalize on any failure. Address only evidence-backed findings, add regression tests first, and rerun affected/full suites.

- [ ] **Step 2: Rebase/merge-check against current `origin/main` without losing user changes**

```bash
rtk git fetch origin
rtk git status --short --branch
rtk git log --oneline --decorate origin/main..HEAD
rtk git diff --check origin/main...HEAD
```

Resolve overlap deliberately; do not use destructive reset or checkout. Rerun Node 22/24 full suites after any integration change.

- [ ] **Step 3: Push and create/update one PR**

Push the current branch, create a PR to `main` if absent, and include root cause, two-stage state flow, failure artifact examples, fake-Redmine PUT/GET evidence, replay evidence, and Node 22/24 results. Trigger only Codex and Gemini mention reviews as requested. Wait for their results, fix supported findings with regression tests, and rerun verification.

- [ ] **Step 4: Merge only after green checks and both requested reviews are handled**

Confirm the merged `main` contains the version-range, rejected-draft, depth-3 evidence fixes plus the weekly pipeline commits. Verify the production checkout points at that merged commit before touching crontab.

- [ ] **Step 5: Back up and atomically replace only Redmine cron entries**

Create `out/crontab-backups` and save `crontab -l` before mutation. Produce a candidate that removes only these existing entries:

```text
5 6 * * 3 ... MODE=collect .../run-report-env.sh ...
15 6 * * 3 ... MODE=generate .../run-report-env.sh ...
45 6 * * 3 ... MODE=update .../run-report-env.sh ...
```

and inserts exactly:

```cron
5 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-prepare-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
45 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-publish-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
```

Before `crontab <candidate>`, compare non-Redmine lines between backup and candidate and require exact equality. Abort on zero/multiple old-match ambiguity. After install, run `rtk crontab -l` and assert old lines count 0, each new line count 1, and all unrelated entries unchanged.

- [ ] **Step 6: Perform rollout checks without rewriting this week's Wiki**

Run shell syntax checks from the production checkout and a complete prepare/publish integration against a local fake Redmine endpoint with isolated `OUTPUT_DIR`. Do not point `WIKI_URL` at production. Confirm the real crontab invokes absolute production paths and the scripts are executable.

- [ ] **Step 7: Define the live stop condition and handoff**

Implementation/rollout is complete when:

1. merged production code passes both Node runtimes;
2. deterministic 2026-09-09 replay is publishable with the corrected facts;
3. fake Redmine run reaches `published` only after PUT/GET equality;
4. cron backup exists and exact two-line schedule is installed;
5. no production Redmine write occurred during rollout.

The first scheduled live confirmation is the next Wednesday run: `06:05 ready`, `06:45 published`, matching remote section hash. If it fails, the immutable failure artifact and single alert are the evidence for repair; do not bypass validation or blindly rerun a stale `publishing` attempt.

## Execution Notes

- Baseline branch: `fix/source-selection-version-range`, based on `origin/main`, with the version-range, failed-draft retention, depth-3 selection, cause/fix evidence, dual-wide correction, and approved design commits already present.
- Baseline operational incident: 2026-09-09 freeform generation failed before source-selection deployment; independent update then emitted a secondary missing-draft alert. The post-merge replay exposed the separate `2.12-rc1/2.12` ratio false positive.
- Existing successful manual artifact/server publication is evidence for report content, not for the new two-stage cron state machine.
- Task 7 deterministic replay command (offline only): `rtk /home/jhw/.nvm/versions/node/v22.23.1/bin/node scripts/replay-source-selection.js --snapshot /home/jhw/ai/opencode/projects/redmine/out/report-2026-09-09.snapshot.json --draft /home/jhw/ai/opencode/projects/redmine/out/runs/2026-09-09/6ba8b9e2-8af9-41d7-9b4c-cc2943f2dcfa/draft.working.annotated.md --output-dir out/replay-weekly-pipeline-task7-final-20260909/2026-09-09`. It made no AI call, live status check, provider call, or Redmine request.
- Task 7 replay inputs: snapshot file SHA-256 `ec5aa022f43eb20c52f6a2a832945f7c34964dc16d4b464ae6fe46312ff2fa0a` (sealed content hash `f03aa1505e02657a2f039916dc0fe1fd2b5887e033d12e62ca106dc8e7f9114c`) and prior annotated draft SHA-256 `82be27f79e8b67f2c3d780fc684cec04a538ddf6db8b79cfd33c1b75be0fb94b`. Ruling: the linked worktree has the earlier replay directory but not its sealed snapshot or historic run directory, so the immutable files in the main checkout's ignored `out/` were read in place rather than copied or recollected; if those paths are not retained, this exact replay command is not portable even though the recorded hashes still identify the inputs.
- Task 7 replay result: `out/replay-weekly-pipeline-task7-final-20260909/2026-09-09/`; `report.md` SHA-256 `b5d0f867228b9bab97b27da645c1d201ab6046dbba5bcb5707a83f3efdd5e065`, validation artifact SHA-256 `972bdf9b049f7bd79d5deb29ef25489eddbfec1b4b08223de97eaaad7277e64e`, selection artifact SHA-256 `dd50db8360512200ec734bb4865632e59bca724e384a00e4ae1a471730efd751`. Depth 3 selected 24 of 431 source records. Validation was publishable `WARNING`, with 0 error blockers and 168 advisory `missing_source_id` warnings. The prior freeform draft comparison remained `FAIL` with 9 `fact_subject_mismatch` errors.
- Task 7 replay content ruling: no saved 2026-09-09 snapshot contains the literal `wpa_supplicant 2.12-rc1/2.12`; the canonical snapshot contains `wpa_supplicant 2.12` and predates hydrated `↳ 원인/수정/검증` briefing lines. No single historical sealed artifact can prove both incident fixes, so acceptance is split without editing or synthesizing sealed input: (a) a no-I/O exact-string validator check classified `2.12-rc1/2.12` as one `named_version` bound to `wpa_supplicant`, preserved it byte-for-byte, and passed with 0 blockers; (b) the latest saved v5 sealed snapshot and its complete depth-3 schema-v2 `source_selection` run preserve the corrected same-`exp_time`, asymmetric-`ae_on` cause, pair-level fix, and measured verification. If a single-artifact replay is later required, a newly collected sealed input containing both facts is necessary.
- Task 7 v5 evidence replay command (offline only): `rtk /home/jhw/.nvm/versions/node/v22.23.1/bin/node scripts/replay-source-selection.js --snapshot /home/jhw/ai/opencode/projects/redmine/out/meeting-report-20260909-v5/report-2026-09-09.snapshot.json --draft /home/jhw/ai/opencode/projects/redmine/out/meeting-report-20260909-v5/runs/2026-09-09/119c25fb-4688-41e9-913c-1646e4aa7f53/draft.working.annotated.md --output-dir out/replay-weekly-pipeline-task7-v5-20260909/2026-09-09`. Snapshot file SHA-256 is `0c5415aefba0694e3bff304c25132043df02e86fa46922b56c0c5a93312426a9` (sealed content hash `ef91f41c4cf2ac6f1c8482b069324a356b94eb3e19bc78840fc176fbb62806a6`); run state SHA-256 is `05e15c2364c473123797778745abac379f53678257cd352b33982771a05dceee`, source selection SHA-256 is `339901f2e2b73539e49ffded621d9e3547fc4dde5432dd00409f2ed5bd2b361f`, working draft SHA-256 is `2a9c192ed0dea3e6de590ad2acccbb5e28db97a0796899e88156b9df8b40706d`, clean report SHA-256 is `59771afb0e1419fbd17989e19ea857ee08bf69134fe8763ad54630326084e6fe`, and validation SHA-256 is `ed3c16038ca47db7575b0a1492592f28971624676906a9213168f4232bcdc708`. The stored run is `complete`, depth 3, `source_selection`, publishable `WARNING`, with 0 error blockers and 157 advisory `missing_source_id` warnings. The fresh v5 replay also produced a publishable `WARNING` with 0 blockers; its previous-draft comparison is publishable `WARNING` with 0 blockers.
- Task 7 runtime evidence: the exact requested dot-reporter commands passed on Node 22.23.1 and Node 24.12.0, each with 561 tests, 561 pass, 0 fail. Full dot logs are under `out/task7-acceptance-20260909/node22-full.log` and `node24-full.log`; spec-reporter logs with counts are alongside them.

### Acceptance-criterion coverage audit

| AC | Named test or rollout check | Task 7 status |
| ---: | --- | --- |
| 1 | `weekly prepare validates sealed source-selection evidence before binding READY to file bytes` | Passed in both full suites |
| 2 | `weekly prepare records collection exceptions and partial snapshots as collect_failed`; `weekly prepare records escaped provider failures as ai_failed`; `weekly prepare records escaped source-selection failures separately`; `weekly prepare records rejected validation with its validation and rejected report artifacts` | Passed in both full suites |
| 3 | `weekly prepare records rejected validation with its validation and rejected report artifacts`; `v2 validation failure preserves the previous report and never retries Claude` | Passed in both full suites |
| 4 | `weekly publish skips terminal states once without calls or artifacts`; `weekly publish CLI resolves terminal skips without credentials or new artifacts` | Passed in both full suites |
| 5 | `weekly publish records incomplete attempts and never retries external work`; `weekly publish rejects changed READY evidence before calling update` | Passed in both full suites |
| 6 | `weekly publish verifies a stateful Wiki and preserves written failures without retry` (success case); `update exposes callback boundaries and returns the exact post-write server section` | Passed in both full suites |
| 7 | `weekly publish verifies a stateful Wiki and preserves written failures without retry` (mismatch/verify failure cases); `weekly remote equality gates prior published bytes and completed-note closure` | Passed in both full suites |
| 8 | `a new weekly attempt replaces only status.json and preserves the meeting directory`; `weekly failure destinations are immutable and a later attempt preserves prior evidence`; `weekly failure records immutable JSON and ordered Markdown with owned artifact hashes` | Passed in both full suites |
| 9 | Exact Node 22.23.1 and Node 24.12.0 full-suite commands | 561/561 pass on each runtime |
| 10 | `weekly wrappers apply fixed profiles after .env and preserve caller recovery values`; `weekly wrapper failures alert once and terminal publish skips without another alert` | Passed in both full suites |
| 11 | Canonical Task 7 offline replay; exact-string `wpa_supplicant 2.12-rc1/2.12` no-I/O validator check; latest saved v5 sealed snapshot and complete source-selection run; `depth 3 snapshots preserve source-grounded cause, fix, and verification details` | Passed by the recorded evidence split; no single historical sealed artifact contains both fixes |
| 12 | Task 8 `local fake Redmine integration`, `production checkout`, `crontab backup/exact replacement`, and next-Wednesday `READY/PUBLISHED` rollout checks | Mapped; pending Task 8 and not claimed here |

- Add review findings, PR URL, merge commit, cron backup path, and installed-cron verification during Task 8 execution only.
