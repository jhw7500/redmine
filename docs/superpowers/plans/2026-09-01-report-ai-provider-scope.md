# Report AI Provider and Generation Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 전체 Claude 생성을 기본값으로 보존하면서 Claude/Codex 공급자와 whole/project 생성 범위를 명시적으로 선택하고 같은 검증 계약으로 비교할 수 있게 한다.

**Architecture:** 설정은 공급자와 생성 범위를 검증해 정규화하고, `publisher`는 공급자별 CLI invocation과 deterministic generation plan을 사용한다. project plan은 최상위 root별 출력에 가벼운 부분 계약을 적용한 뒤 병합하고, `index`의 기존 V2 reference 확장·전체 검증·immutable artifact 흐름은 병합 결과에 그대로 적용한다.

**Tech Stack:** Node.js CommonJS, `node:test`, Claude CLI, Codex CLI, 기존 schema v2 fact/source validator

**Spec:** `docs/superpowers/specs/2026-09-01-report-ai-provider-scope-design.md`

## Global Constraints

- `AI_GENERATION_SCOPE` 기본값은 `whole`이며 기존 한 번 호출 결과 형식을 보존한다.
- `project` root 순서는 PIM, Wireless Lan, ETC이고 설정 category parent에서 파생한다.
- 자동 재시도, 자동 provider fallback, Redmine 게시를 비교 실행에 포함하지 않는다.
- 동일 작업 중복 제거를 강화하되 줄 수를 새로운 blocking 기준으로 만들지 않는다.
- fact/source/open-status 검증은 provider와 scope에 관계없이 동일하게 유지한다.
- 새 런타임 의존성을 추가하지 않는다.

---

### Task 1: 공급자와 생성 범위 설정 계약

**Files:**
- Modify: `lib/config.js`
- Modify: `repo-config.json`
- Test: `lib/__tests__/config-read-json.test.js`

**Interfaces:**
- Consumes: 기존 `resolveChoice`, `resolveNonEmptyString`, `raw.defaults`
- Produces: `config.env.aiProvider`, `config.env.aiGenerationScope`, `config.env.codexCli`, 공급자별 `config.env.aiModel`

- [ ] **Step 1: 기본값과 명시 선택을 검증하는 실패 테스트 작성**

```js
assert.strictEqual(config.env.aiProvider, "claude");
assert.strictEqual(config.env.aiGenerationScope, "whole");
assert.strictEqual(config.env.aiModel, "sonnet");

assert.strictEqual(codex.env.aiProvider, "codex");
assert.strictEqual(codex.env.aiGenerationScope, "project");
assert.strictEqual(codex.env.aiModel, "gpt-5.6-sol");
```

- [ ] **Step 2: 설정 테스트가 새 필드 부재로 실패하는지 확인**

Run: `node --test lib/__tests__/config-read-json.test.js`

Expected: `aiProvider` 또는 `aiGenerationScope`가 `undefined`여서 FAIL

- [ ] **Step 3: 최소 설정 파싱 구현**

`AI_PROVIDER`는 `claude|codex`, `AI_GENERATION_SCOPE`는 `whole|project`로 `resolveChoice`한다. `AI_MODEL`이 없으면 Claude는 기존 `defaults.aiModel || "sonnet"`, Codex는 `defaults.codexModel || "gpt-5.6-sol"`을 쓴다. `CODEX_CLI`는 `defaults.codexCli || "codex"`로 해석한다.

- [ ] **Step 4: 설정 테스트 통과 확인**

Run: `node --test lib/__tests__/config-read-json.test.js`

Expected: PASS

### Task 2: Claude/Codex 단일 호출 경계

**Files:**
- Create: `lib/ai-text-provider.js`
- Modify: `lib/publisher.js`
- Test: `lib/__tests__/publisher-ai-budget.test.js`

**Interfaces:**
- Consumes: `config.env.aiProvider`, `aiModel`, `aiEffort`, `claudeCli`, `codexCli`, `aiMaxBudgetUsd`
- Produces: `buildAiInvocation(prompt, config) -> { command, args, stdin, cwd, providerLabel, cleanup }`
- Produces: 기존 `aiSummarize(rawContent, config, meetingDate, options) -> Promise<string>` 유지

- [ ] **Step 1: 실제 fake CLI로 두 공급자의 argv/stdin 계약을 검증하는 실패 테스트 작성**

Claude 테스트는 기존 `--safe-mode`, 빈 tools, `--model sonnet`, `--effort low`, `-p <prompt>`를 유지한다. Codex 테스트는 `exec`, `--ephemeral`, `--ignore-user-config`, `--sandbox read-only`, `--model gpt-5.6-sol`, `model_reasoning_effort=medium`, `-`와 stdin prompt를 확인한다.

- [ ] **Step 2: 공급자 테스트가 Codex 분기 부재로 실패하는지 확인**

Run: `node --test lib/__tests__/publisher-ai-budget.test.js`

Expected: fake Codex가 실행되지 않거나 Claude argv를 받아 FAIL

- [ ] **Step 3: invocation builder와 공통 spawn runner 구현**

Claude 출력 정제와 예산 인자는 그대로 유지한다. Codex는 비어 있는 임시 cwd에서 read-only·ephemeral로 실행하고 stdin을 닫는다. timeout은 기존 process-group SIGTERM→SIGKILL 경계를 공유한다. 공급자별 exit 메시지만 다르게 하며 공통 `AI_TIMEOUT`, `AI_QUOTA`, `AI_AUTH`, `AI_EXIT` 코드를 유지한다.

- [ ] **Step 4: 공급자·timeout 회귀 테스트 통과 확인**

Run: `node --test lib/__tests__/publisher-ai-budget.test.js`

Expected: PASS

### Task 3: whole/project generation plan과 deterministic merge

**Files:**
- Create: `lib/report-generation-plan.js`
- Modify: `lib/publisher.js`
- Test: `lib/__tests__/report-generation-plan.test.js`
- Test: `lib/__tests__/publisher-ai-budget.test.js`

**Interfaces:**
- Produces: `buildGenerationPlan(rawContent, config, meetingDate, promptOptions, promptBuilder) -> { scope, calls, promptHash }`
- Produces: `mergeProjectOutputs(outputs, sectionHeader) -> string`
- Each `calls[]`: `{ id: "whole"|"PIM"|"Wireless Lan"|"ETC", source, prompt, promptHash, promptLength }`
- `generateContent` consumes optional prebuilt `generationPlan` and returns `generationPlan` with existing fields.

- [ ] **Step 1: split 경계·고정 순서·빈 root 생략·merge를 검증하는 실패 테스트 작성**

손으로 만든 header/PIM/Wireless Lan/ETC fixture에서 각 source가 다른 root를 포함하지 않고, merge가 header 하나와 PIM→Wireless Lan→ETC 순서를 갖는지 단언한다. root 밖 bullet을 출력한 fixture는 merge가 거부해야 한다.

- [ ] **Step 2: generation plan 테스트가 모듈 부재로 실패하는지 확인**

Run: `node --test lib/__tests__/report-generation-plan.test.js`

Expected: `MODULE_NOT_FOUND` 또는 export 부재로 FAIL

- [ ] **Step 3: line/indent 기반 root subtree 분리와 merge 최소 구현**

조현우 header 뒤의 indent 0 bullet을 root 경계로 사용한다. root 목록은 `config.categories`의 parent 중복 제거 순서로 구한다. project prompt에는 `generationRoot` 범위 지시를 추가한다. whole plan은 기존 prompt 하나와 동일 hash를 반환한다.

- [ ] **Step 4: 계획 단위 테스트 통과 확인**

Run: `node --test lib/__tests__/report-generation-plan.test.js lib/__tests__/publisher-ai-budget.test.js`

Expected: PASS

### Task 4: 부분 검증과 schema v2 산출물 통합

**Files:**
- Modify: `lib/report-generation-plan.js`
- Modify: `lib/publisher.js`
- Modify: `index.js`
- Modify: `lib/__tests__/report-generate-v2.test.js`
- Modify: `lib/__tests__/helpers/report-run-fixture.js`

**Interfaces:**
- Consumes: `validateAnnotatedReport`, `validateSourceCoverage`, full fact catalog, root-filtered coverage catalog
- Produces: part result `{ id, status, issues }`; blocking part는 `AI_PART_VALIDATION` 오류
- `prompt-input.json` whole fields: 기존 필드 + `provider`, `generationScope`, `callCount`
- `prompt-input.json` project fields: 위 필드 + `calls[{ id, promptHash, promptLength }]`

- [ ] **Step 1: project가 세 fake 호출을 하고 병합 draft를 전체 검증하는 실패 테스트 작성**

PIM/Wireless Lan/ETC가 모두 있는 schema v2 fixture에서 fake CLI가 stdin/argv prompt에 따라 각 root 출력을 반환하게 한다. call count 3, merged order, immutable AI draft, prompt metadata를 단언한다. PIM에 새 숫자를 만든 fixture는 첫 part 후 `AI_PART_VALIDATION`으로 멈추고 call count 1을 단언한다.

- [ ] **Step 2: V2 통합 테스트가 단일 호출 때문에 실패하는지 확인**

Run: `node --test lib/__tests__/report-generate-v2.test.js`

Expected: 예상 3회 대신 1회이거나 project metadata 부재로 FAIL

- [ ] **Step 3: 부분 검증·병합 결과·artifact metadata 구현**

각 sanitized part에 `validateAnnotatedReport`를 실행하고 root-filtered coverage 결과를 기존 severity 정책으로 판정한다. error가 있으면 다음 호출 없이 실패한다. 모든 part가 끝나면 병합 annotated draft를 `onRawAiOutput`에 한 번 전달한다. `index`는 generation plan을 AI 호출 전에 만들어 immutable prompt metadata를 기록하고 병합 결과에 기존 전체 V2 검증을 수행한다.

- [ ] **Step 4: V2 통합 테스트 통과 확인**

Run: `node --test lib/__tests__/report-generate-v2.test.js lib/__tests__/publisher-ai-budget.test.js lib/__tests__/report-generation-plan.test.js`

Expected: PASS

### Task 5: 중복 제거 지시와 운영 문서

**Files:**
- Modify: `lib/publisher.js`
- Modify: `lib/__tests__/report-depth-profile.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: 기존 `buildAiPrompt`
- Produces: provider/scope 환경변수 문서와 결과 중심 중복 제거 prompt 계약

- [ ] **Step 1: 분량 제한 대신 동일 작업 중복 제거를 요구하는 실패 테스트 작성**

프롬프트가 구현·리뷰·후속 수정 통합, 동일 source 반복 금지, 서로 다른 기능 비병합을 포함하고 새로운 hard line limit를 추가하지 않는지 검증한다.

- [ ] **Step 2: prompt 테스트 실패 확인**

Run: `node --test lib/__tests__/report-depth-profile.test.js`

Expected: 새 중복 제거 문구 부재로 FAIL

- [ ] **Step 3: prompt와 README 최소 수정**

핵심 원칙에 중복 제거 계약을 추가하고 README에 네 환경변수, 기본 whole/Claude, project 3회 호출, Codex 후보 상태, Redmine 게시 전 전체 검증을 설명한다.

- [ ] **Step 4: 전체 회귀 테스트 실행**

Run: `node --test lib/__tests__/*.test.js`

Expected: 0 failures

### Task 6: 동일 스냅샷 A/B/C 비교

**Files:**
- Create: `scripts/ai-provider-scope-spike.js`
- Test: `lib/__tests__/ai-provider-scope-spike.test.js`

**Interfaces:**
- Consumes: sealed snapshot path, provider/model/scope matrix, `runGenerate`
- Produces: temp root 아래 조합별 산출물과 `comparison.json`

- [ ] **Step 1: dry-run matrix와 비교 요약을 검증하는 실패 테스트 작성**

fixture runner를 주입해 six configurations, expected call count 12, no update mode, normalized exact duplicate count, elapsed time과 validation code 집계를 literal로 검증한다.

- [ ] **Step 2: Spike 테스트 실패 확인**

Run: `node --test lib/__tests__/ai-provider-scope-spike.test.js`

Expected: script export 부재로 FAIL

- [ ] **Step 3: 의존성 없는 비교 runner 구현**

기본 matrix는 Sonnet/Opus/GPT-5.6 Sol × whole/project다. 각 조합은 독립 output dir와 snapshot을 사용하며 `runGenerate`만 호출하고 `update`는 호출하지 않는다. 결과 JSON에 status, publishable, issue codes, lines, bullets, normalized exact duplicate groups, elapsedMs, plannedCalls를 기록한다.

- [ ] **Step 4: Spike 단위 테스트와 전체 회귀 테스트 통과 확인**

Run: `node --test lib/__tests__/ai-provider-scope-spike.test.js lib/__tests__/*.test.js`

Expected: 0 failures

- [ ] **Step 5: 2026-08-26 depth3 실제 비교 실행**

Run: `node scripts/ai-provider-scope-spike.js --snapshot /home/jhw/ai/opencode/projects/redmine/out/report-2026-08-26.snapshot.json --depth 3 --effort medium`

Expected: Redmine 요청 없이 최대 12회 호출 후 temp comparison path 출력. 인증 또는 모델 접근 실패 조합은 실패 코드와 경과 시간을 남기고 다른 조합은 계속한다.
