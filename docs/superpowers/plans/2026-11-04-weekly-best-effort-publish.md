# 주간보고 최선 게시와 검토 블록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주간 cron이 검증 실패로 멈추지 않고 Redmine 게시까지 진행하며, 실패 사유와 검토 항목을 게시 섹션 하단 `검토 필요(자동)` 블록에 남긴다.

**Architecture:** 검출 로직은 그대로 두고 실패 시 처리만 바꾼다. 수집은 자격증명 의심 근거를 제외하고 계속하며 제외 목록을 sealed snapshot에 넣는다. pair 생성은 변형별 실패를 manifest에 기록하고 계속한다. 게시는 통과한 변형을 고르고, 통과한 변형이 없으면 가장 나은 거부 보고서를 그대로 게시한다. 어느 경우든 검토 블록을 footer 앞에 붙인다.

**Tech Stack:** Node 18+ CommonJS, `node --test`, 외부 의존성 추가 없음.

**Spec:** GitHub Issue #138 (https://github.com/jhw7500/redmine/issues/138), 결정 D1·D2와 보안 경계(사용자 확인 대상).

## Global Constraints

- 의존성·권한·환경변수·원격 endpoint를 추가하지 않는다.
- 수집 단계에서 자격증명 검사에 걸린 근거(커밋·PR·이슈)의 원문은 AI 입력, Redmine 게시, Slack, 검토 블록, 로그 어디에도 들어가지 않는다. 사유는 scanner의 `kind` 코드만 쓴다(`lib/collector.js:191`). 생성된 보고서 줄은 게시 전에 따로 다시 검사하지 않는다(사용자 결정 2026-11-04: 문제 줄 포함 게시, 보안 경계 미적용).
- 검토 블록에는 validation issue의 `code`, 개수, 보고서 줄 발췌(최대 200자)만 넣는다. `lib/open-issue-verifier.js`의 `issue.evidence`(스캔되지 않은 커밋 제목)와 issue `message`는 넣지 않는다.
- 섹션 헤더 규칙 유지: 게시 섹션의 설정 헤더·파란색 헤더는 정확히 1개(`lib/publisher.js:1091-1099`). 검토 블록은 헤더(`#`)를 쓰지 않는다.
- `assertWeeklyProfile`의 `validationMode: "block"`, `validationOverride: false` 고정은 바꾸지 않는다(`index.js:264-289`). 최선 게시는 별도 경로로 구현하고 일반 `MODE=update`의 차단 동작은 유지한다.
- 알림: 검토 블록이 비어 있지 않은 주에는 기존 실패 알림 채널(notify-send·Telegram·Slack)로 `[REVIEW]` 한 줄을 보낸다(Task 5). 게시할 보고서가 없으면 지금처럼 nonzero로 끝나 `[ALERT] … 보고 실패`가 간다.
- 커밋 메시지는 Change Evidence v1, `Refs #138`.

## Review Focus

1. 세 변형이 모두 실패하고 거부 보고서도 없는 경우(AI 전부 실패) → 빈 섹션을 게시하지 않고 nonzero로 끝나 기존 실패 알림이 간다. (Task 4 테스트)
2. 검토 블록에 들어가는 보고서 줄이 `#### `로 시작하거나 파란색 span을 담는 경우 → 헤더 수 검사를 깨지 않도록 인용 처리된다. (Task 3 테스트)
3. 같은 회의 날짜로 publish가 다시 실행되는 경우 → `[REVIEW]` 알림을 두 번 보내지 않는다. (Task 5 테스트)
4. 최선 게시 뒤 같은 회의 날짜로 publish를 다시 실행하는 경우 → 기존 `Already published` 보호가 그대로 동작한다. (Task 4 테스트)
5. issue가 수십 건인 경우(예: `missing_source_id` 34건) → 블록은 코드별 개수와 오류(error) 줄 최대 20개로 제한된다. (Task 3 테스트)

---

### Task 1: 수집 단계에서 자격증명 의심 근거를 제외하고 계속한다 (D2)

**Files:**
- Modify: `lib/collector.js` (`getGitCommitRecords` `:841-:888`, `integrateRepositoryEvidence` `:1305-:1350`, `collectAll` `:1354-:1415`)
- Modify: `lib/change-evidence.js` (`collectMergedPullRequestEvidence` `:633-:768`)
- Modify: `lib/report-snapshot.js` (`COMMIT_BODY_CREDENTIAL_SCAN_VERSION` `:21`, `sealSnapshot` 입력 `:314-:337`, rethrow `:260`)
- Test: `lib/__tests__/collector-signals.test.js`, `lib/__tests__/report-snapshot.test.js`

**Interfaces:**
- Produces:
  - `getGitCommitRecords(repoPath, since, until, config, repoOpts, deps)`: `deps.onUnsafeEvidence?: (item: {source: "git_commit", ref: string, kind: string}) => void`. 콜백이 있으면 제목 또는 본문이 scanner에 걸린 커밋을 결과에서 빼고 콜백을 호출한다. 콜백이 없으면 지금처럼 throw한다(기존 직접 호출 테스트 유지).
  - `collectMergedPullRequestEvidence(options)`: `options.onUnsafeEvidence?: (item: {source: "pull_request" | "issue", ref: string, kind: string}) => void`. PR 제목·본문이 걸리면 그 PR record를 넣지 않고(`:747`), 연결 이슈가 걸리면 그 이슈만 건너뛴다(`:729-:743`). `ref`는 `"<owner>/<repo>#<number>"`.
  - `collectAll(...)` 반환에 `droppedEvidence: Array<{source: string, repo: string, ref: string, kind: string}>`를 추가한다. git 항목의 `repo`는 repo-config 키, `ref`는 커밋 해시 앞 12자. 정렬·중복 제거한다.
  - sealed snapshot 최상위 `droppedEvidence`(위 배열, 없으면 `[]`). `failures`에는 넣지 않는다(`status`가 `partial`이 되면 안 됨). `COMMIT_BODY_CREDENTIAL_SCAN_VERSION`을 30에서 31로 올린다.

- [ ] **Step 1: Write the failing tests** (`collector-signals.test.js`)
  - `"public collection drops a credential-bearing commit and records it without the value"`: 커밋 2개 중 1개 본문에 가짜 `GITHUB_TOKEN=fixture-secret-123`. `collectAll` 결과의 git items에 그 커밋이 없고 다른 커밋은 있음. `droppedEvidence`에 `{source:"git_commit", ref:<12자>, kind:"credential_assignment"}`가 있음. 결과 전체 JSON 문자열에 `fixture-secret-123`이 없음.
  - 기존 `:1444`, `:1520`, `:1662` 세 테스트를 "rejects … before artifacts"에서 "drops … before artifacts"로 바꾼다. throw 대신 해당 PR, 이슈, 커밋이 결과와 산출물에 없고 `droppedEvidence`에 kind가 있으며, 비밀값이 산출물 파일 어디에도 없음을 단언한다.
  - 직접 `getGitCommitRecords`를 콜백 없이 부르는 기존 테스트는 그대로 둔다(throw 유지 확인).
- [ ] **Step 2: Run** `node --test lib/__tests__/collector-signals.test.js` → 새·수정 테스트 FAIL 확인.
- [ ] **Step 3: Implement** 위 Interfaces대로. `report-snapshot.js:260` rethrow는 남겨 둔다(콜백 경로에서는 throw가 오지 않음).
- [ ] **Step 4: Update** `report-snapshot.test.js`의 scan version 고정(`:177`, `:230`)을 31로 바꾸고, `droppedEvidence`가 `contentHash` 대상에 들어가는지 단언한다(값을 바꾸면 해시가 바뀜).
- [ ] **Step 5: Run** `node --test lib/__tests__/collector-signals.test.js lib/__tests__/report-snapshot.test.js` → PASS.
- [ ] **Step 6: Commit** `fix(report): 자격증명 의심 근거는 제외하고 수집을 계속한다` (Refs #138)

### Task 2: pair 생성이 변형 실패를 기록하고 계속한다

**Files:**
- Modify: `lib/weekly-report-pair.js` (`prepareWeeklyPair` `:150-:192`, `readWeeklyPair` `:205-:220`, `verifyVariant` `:195-:204`)
- Test: `lib/__tests__/weekly-report-pair.test.js`

**Interfaces:**
- Consumes: `runWeeklyPrepare`가 실패 시 던지는 오류의 `error.weeklyFailure`(`index.js:580-:598`). 여기에는 `pipelineAttemptId`와 failure artifact 경로가 들어 있다. 생성 상태 `status:"failed"`, `latestValidationPath`, `latestRejectedReportPath`, `latestRejectedReportHash`(`index.js:1072-:1084`, `:752`).
- Produces: manifest `schemaVersion: 2`.
  - `variants["2"|"3"]`는 `{status:"ready", reportHash, generationAttemptId, pipelineAttemptId}`이거나 `{status:"failed", primaryIssueCode, issueCounts, rejectedReportPath, rejectedReportHash, validationPath, pipelineAttemptId}` 중 하나다.
  - 거부 보고서가 없으면 `rejectedReportPath`와 `rejectedReportHash`는 `null`이다.
  - `readWeeklyPair`는 schemaVersion 1·2를 모두 읽는다. 1은 기존과 같이 해석한다.
  - `failed` 변형은 `detailOnly`/게시 선택에서 READY 검증 없이 노출한다.

- [ ] **Step 1: Write the failing tests**
  - `"a failed depth3 still prepares depth2 and records the failure in the manifest"`: depth3 generate가 `VALIDATION_FAILED`를 던지게 한다. 결과 manifest는 `variants["3"].status === "failed"`, `primaryIssueCode === "open_status_without_as_of"`, `variants["2"].status === "ready"`이고 `summary.json`도 생성된다.
  - `"both depth variants failing still writes a manifest with two failed variants"`.
  - 기존 `"summary generation or validation failure never fails the pair..."`(`:454`)는 그대로 통과해야 한다.
- [ ] **Step 2: Run** `node --test lib/__tests__/weekly-report-pair.test.js` → 새 테스트 FAIL.
- [ ] **Step 3: Implement**: depth 루프의 `runWeeklyPrepare`를 try/catch로 감싼다. `error.weeklyFailure`가 있는 오류만 failed 변형으로 기록한다. 그 밖의 오류(snapshot 봉인 실패 등)는 지금처럼 throw한다.
- [ ] **Step 4: Run** 같은 파일 → PASS.
- [ ] **Step 5: Commit** `fix(report): 주간 pair가 변형 실패를 기록하고 생성을 계속한다` (Refs #138)

### Task 3: 검토 블록 생성기

**Files:**
- Create: `lib/review-block.js`
- Test: `lib/__tests__/review-block.test.js`

**Interfaces:**
- Produces: `buildReviewBlock({published, variants, summary, droppedEvidence}) -> string`.
  - `published`는 `{variant: "summary" | "2" | "3", status: "ready" | "failed"}`이다.
  - `variants`는 Task 2 manifest variants, `summary`는 `summary.json`, `droppedEvidence`는 Task 1 배열이다.
  - 반환은 빈 문자열(검토할 것이 없을 때) 또는 Markdown 블록이다. 블록 형식:
    - 첫 줄 `**검토 필요(자동)**`
    - `- 게시본: <변형> (<통과|검증 실패 그대로 게시>)`
    - `- <변형>: <primaryIssueCode> 외 코드별 개수`
    - 발췌 줄 `  - \`<보고서 줄 200자>\``
    - `- 수집 제외: <repo> <ref> (<kind>)`
- 발췌는 해당 변형의 validation 파일에서 `severity:"error"` issue의 `line`만, 변형당 최대 20줄 읽는다. `message`와 `evidence`는 쓰지 않는다.
- 백틱은 이스케이프하고, 줄 앞 `#`와 `<span`이 헤더로 해석되지 않도록 인라인 코드 안에 둔다.

- [ ] **Step 1: Write the failing tests** (`review-block.test.js`)
  - `"no failures and no drops yields an empty block"`
  - `"a failed variant lists its codes, counts and error lines"`: `open_status_without_as_of` 2건과 경고 34건을 넣는다. 블록에 오류 줄 2개와 `missing_source_id 34`가 있고, 경고 줄 발췌는 없다.
  - `"excerpts are capped at 20 per variant and 200 characters"`
  - `"a header-like or blue-span excerpt cannot add a section header"`: 발췌 `#### <span style="color:blue">조현우</span>`에 대해 블록 안 `#### <span style="color:blue">` 출현 0회.
  - `"dropped evidence is listed by repo, ref and kind only"`
- [ ] **Step 2: Run** `node --test lib/__tests__/review-block.test.js` → FAIL(모듈 없음).
- [ ] **Step 3: Implement** `buildReviewBlock`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(report): 주간보고 검토 블록 생성기를 추가한다` (Refs #138)

### Task 4: 최선 게시와 검토 블록 삽입 (D1)

**Files:**
- Modify: `lib/publisher.js` (`update` `:989-:1111`)
- Modify: `index.js` (`runUpdate` `:1717-:1860`)
- Modify: `lib/weekly-pipeline.js` (`runWeeklyPublish` `:756-:839`)
- Modify: `lib/weekly-report-pair.js` (`selectSummary` `:255-:278`, `publishWeeklyPair` `:280-:335`)
- Test: `lib/__tests__/weekly-report-pair.test.js`, `lib/__tests__/report-update-v2.test.js`, `lib/__tests__/weekly-pipeline.test.js`

**Interfaces:**
- Consumes:
  - Task 2 manifest(schemaVersion 2)
  - Task 3 `buildReviewBlock`
  - Task 1 `snapshot.droppedEvidence`
- Produces:
  - `update(config, meetingDate, options)`에 `options.reviewBlock?: string`을 추가한다. 내용 검증(`assertReady`, `:1111`)은 블록을 넣기 전 섹션에 수행한다.
    - 블록은 notes block 뒤, footer 앞(`:1078`~`:1080` 사이)에 빈 줄 하나를 두고 넣는다.
    - 헤더 수 검사(`:1091-:1099`)는 블록을 넣은 최종 섹션에 수행한다.
  - `publishWeeklyPair(config, meetingDate, {depth: "auto", ...})`가 게시할 변형을 다음 순서로 고른다.
    1. ready 요약본(`selectSummary`)
    2. ready depth2
    3. ready depth3
    4. 셋 다 아니면 거부 보고서가 있는 변형을 요약본 → depth2 → depth3 순서로 골라 **그대로**(D1) 게시
  - 거부 보고서 게시는 READY 검증과 `assertPublishable`을 건너뛰는 별도 함수 `runWeeklyPublishRejected(variantConfig, meetingDate, {reportPath, reportHash, reviewBlock})`를 쓴다.
    - 이 함수는 snapshot 해시 결합과 보고서 해시 일치를 검사한다.
    - receipt는 `variant: "<이름>"`, `status: "rejected_published"`로 남긴다.
  - 게시할 보고서가 하나도 없으면 `NO_PUBLISHABLE_REPORT`로 throw한다(exit nonzero → 기존 실패 알림).
  - 검토 블록이 비어 있지 않으면 `OUTPUT_DIR/ALERT.log`에 `[WARN] <시각> redmine 검토 필요 — <변형> (<코드>)` 한 줄을 남기고, `pair.root/review-needed.json`(`{schemaVersion:1, meetingDate, variant, codes}`)을 immutable로 쓴다(Task 5가 읽음).

- [ ] **Step 1: Write the failing tests**
  - `report-update-v2.test.js`: `"a review block is placed after notes and before the footer and is excluded from content validation"`. 블록 위치는 footer 바로 앞이다. 블록에 `미해결` 같은 단어가 있어도 `assertReady`에 넘어간 내용에는 블록이 없다.
  - `weekly-report-pair.test.js`: `"auto publishes ready depth2 with a review block when depth3 failed"`.
  - `weekly-report-pair.test.js`: `"auto publishes the rejected summary as is when no variant passed"`. 게시 섹션에 거부 보고서 본문과 검토 블록이 모두 있다.
  - `weekly-report-pair.test.js`: `"no publishable report fails with NO_PUBLISHABLE_REPORT and writes nothing"`.
  - `weekly-report-pair.test.js`: `"re-running publish after a rejected publication is refused"` (기존 `Already published` 보호).
  - 기존 `"a summary blocked by the quality gate ... auto publishes depth2"`(`:396`)는 새 순서에서도 통과해야 한다.
- [ ] **Step 2: Run** 세 테스트 파일 → 새 테스트 FAIL.
- [ ] **Step 3: Implement** 위 Interfaces대로.
- [ ] **Step 4: Run** 세 파일 → PASS.
- [ ] **Step 5: Run** 전체 `node --test lib/__tests__/*.test.js` 1회 → 실행·통과·실패·skip 수 기록.
- [ ] **Step 6: Commit** `feat(report): 검증 실패 시에도 주간보고를 게시하고 검토 블록을 남긴다` (Refs #138)

### Task 5: 검토 필요 알림

**Files:**
- Modify: `run-report-env.sh` (실패 알림 블록 `:155-:197`)
- Test: `lib/__tests__/run-report-env.test.js`

**Interfaces:**
- Consumes: Task 4가 쓰는 `OUTPUT_DIR/pairs/<날짜>/review-needed.json`.
- Produces: 실패 알림 블록을 `send_alert "<한 줄>"` 함수로 뺀다(notify-send·Telegram·Slack 전부 best-effort, 기존 동작과 문구 유지). `MODE=weekly-pair-publish`가 exit 0으로 끝나고 이번 회의 날짜의 `review-needed.json`이 있고 `review-needed.notified`가 없으면 `[REVIEW] <시각> redmine 검토 필요 — 변형 <variant>, 사유 <codes> (위키 하단 참고)`를 `send_alert`로 보내고 `review-needed.notified`를 만든다. exit status는 바꾸지 않는다.

- [ ] **Step 1: Write the failing tests** (`run-report-env.test.js`, 기존 fake 알림 채널 방식 사용)
  - `"a successful pair publish with review-needed sends one [REVIEW] notice"`
  - `"a second run for the same meeting date does not resend [REVIEW]"`
  - `"a successful publish without review-needed sends nothing"`
  - 기존 실패 알림 테스트는 문구 그대로 통과해야 한다.
- [ ] **Step 2: Run** `node --test lib/__tests__/run-report-env.test.js` → 새 테스트 FAIL.
- [ ] **Step 3: Implement** 위 Interfaces대로. `bash -n run-report-env.sh` 통과, 실행 비트 유지.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(report): 주간보고 검토 필요 알림을 보낸다` (Refs #138)

### Task 6: 운영 문서

**Files:**
- Modify: `docs/ai-generation-usage.md` (주간 pair 절)

- [ ] **Step 1:** 최선 게시 순서, 검토 블록 형식, 수집 제외(D2), `[REVIEW]` 알림을 한 절로 적는다. 저장소 루트 문서(README.md·AGENTS.md)는 이번 범위에서 건드리지 않는다(Tribunal risk floor 100 경로).
- [ ] **Step 2: Commit** `docs(report): 주간보고 최선 게시와 검토 블록을 안내한다` (Refs #138)
