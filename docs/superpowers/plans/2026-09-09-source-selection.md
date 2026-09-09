# Source Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원문 단위 선택과 렌더링으로 주간보고 사실 문맥 변조를 제거한다.

**Architecture:** 기존 v2 artifact/state/검증/게시 경로를 유지한다. 독립 source-selection 모듈이 원문 레코드·선택 JSON·Markdown을 연결하고 evidence 모듈이 재검증과 게시의 원문 결속을 검사한다.

**Tech Stack:** Node.js CommonJS, node:test, 기존 CLI provider. 추가 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-09-09-source-selection-design.md`

## Global Constraints

- 기존 기본값 `freeform`, 새 옵션 `AI_GENERATION_METHOD=source_selection`.
- `source_selection`은 `whole`만 지원하고 AI 최대 한 번 호출.
- `SOURCE_SELECTION_FALLBACK=1`은 새 방식에서만 사용; 검증/소유권 실패는 우회 금지.
- 자동 기준일 생성 금지. 원문 전체·부모 문맥·카테고리 결속 유지.
- commit/push, 실제 cron 변경, Redmine 게시 없음.

## Task 1: 기존 검증기의 장식 불변성과 명시적 버전

Files: `lib/fact-occurrences.js`, `lib/fact-validator.js`, `lib/__tests__/fact-contract-validator.test.js`.

- [x] `1080p는 30 유지`와 밑줄 버전의 검증 결과가 같아야 한다는 테스트 작성/실패 확인.
- [x] GLIBC 2.33 및 wpa_supplicant 2.12의 형용사/조사 변경 허용, 제품·값 변조 거부 테스트 작성/실패 확인.
- [x] claim context의 장식 제거 시 offset을 보정하고, 명시적 제품 버전은 별도 유형과 제품 결속으로 검증.
- [x] `node --test lib/__tests__/fact-contract-validator.test.js lib/__tests__/fact-catalog.test.js` 통과 확인.

```js
assert.equal(validate('1080p는 [[fact:Q0001|30]] 유지').status, 'PASS');
assert.equal(validate('<u>1080p는 [[fact:Q0001|30]] 유지</u>').status, 'PASS');
```

## Task 2: 원문 레코드·선택·렌더링

Files: create `lib/source-selection.js`, `lib/__tests__/source-selection.test.js`.

Interfaces: `buildSourceRecords(snapshot, annotatedSource, coverageCatalog)` returns catalog; `parseSourceSelection(text, records)` validates and returns selection; `buildFallbackSelection(records)` returns selection; `renderSourceSelection(records, selection, options)` returns annotated Markdown; `buildSelectionPrompt(records, config)` returns prompt.

- [x] 작은 PIM/WLAN 원문과 부모 조건 fixture를 만들고 ID 선택/조건 보존·카테고리 변경·중복·unknown field·빈 선택 거부 테스트 작성.
- [x] 누락된 모듈 실패 확인 후 실제 모듈 구현.
- [x] 원문 leaf 및 부모 경로를 보존하며 고정 theme 목록으로 선택 JSON 검사. 원문 등장 순서의 결정적 대체 선택 구현.
- [x] `node --test lib/__tests__/source-selection.test.js` 통과 확인.

```js
const selected = {sections:[{id:'C0001',groups:[{theme:'stability',items:[{id:'R0001',highlight:true}]}]}]};
assert.match(renderSourceSelection(records, selected), /720p/);
assert.throws(() => parseSourceSelection('{"sections":[],"text":"invented"}', records));
```

## Task 3: 생성·증거·게시 통합

Files: `index.js`, `lib/config.js`, create `lib/source-selection-evidence.js`, `lib/__tests__/source-selection-run.test.js`.

Interfaces: existing `runGenerateV2`, `runRevalidate`, `assertV2PublishEvidence`; source selection evidence is checked against snapshot + stored fact/coverage catalog and regenerated report.

- [x] fake external CLI로 정상 선택/잘못된 JSON/exit 실패/대체 비활성/변조를 테스트하고 실패 확인.
- [x] 옵션 로드, custom selection prompt, immutable 선택 증거 저장, 공통 검증·승격 연결.
- [x] 재검증/게시에서 선택 방식 downgrade·record/selection hash mismatch·문장 변조 거부. 상태 경고 강화.
- [x] 실패 진단 로그와 update의 선행 실패 안내 추가.
- [x] 통합·기존 v2 회귀 테스트 통과 확인.

```js
const generated = await runGenerateV2(config, meetingDate);
assert.notEqual(generated.validation.status, 'FAIL');
assert.equal(JSON.parse(fs.readFileSync(generated.generationStatePath)).status, 'complete');
```

## Task 4: 과거 재생·리뷰·운영 안내

Files: create `scripts/replay-source-selection.js`; update `docs/ai-generation-usage.md`.

- [x] 외부 AI/게시 없이 snapshot + 기존 raw draft를 비교하는 재생 도구 구현·검증.
- [x] 08-26/09-02/09-09 스냅샷 비교. 상태 검증 실패를 숨기지 않고 결과 기록.
- [x] `node --test lib/__tests__/*.test.js` 전체 검증과 독립 코드 리뷰 수행.
- [x] 사용 옵션·대체본·복구 제약 및 실제 운영 미전환 상태 문서화.

## Execution notes

- Baseline: 400 pass, 0 fail (2026-09-09).
- 사용자 승인된 설계의 구현은 이 세션에서 계속 진행한다. 세부 구현 변경은 설계 계약 안에서 결정한다.
- Worktree: `.worktrees/report-source-selection`, branch `fix/report-source-selection`, base `5f35ff9e9c5b4f1764d6bccf8efa3286540d8e50` (`docs/handoff-issue-publisher-hardening`). 원래 체크아웃은 변경하지 않았다.
- Final: Node 22.23.1 및 운영 Node 24.12.0 각각 **422 pass, 0 fail**, `git diff --check` 통과. 로그: `/tmp/redmine-source-selection-final-node22.log`, `/tmp/redmine-source-selection-final-node24.log`.
- Node 24에서 기존 pruner 테스트의 symlink 정리 실패가 원래 checkout에서도 재현됐다. 테스트 cleanup만 `rmSync`에서 `unlinkSync`로 수정했으며 운영 pruner 코드는 변경하지 않았다.
- 독립 리뷰 최초 REQUEST CHANGES의 4건(부모 prose 조건 손실, 구 Q-version 카탈로그 호환, provider partial stdout 손실, theme 타입)을 재현·수정. 재리뷰 APPROVE, spec PASS, 구조 CLEAR.
- 과거 replay 최종 산출물: 이 worktree의 `out/replay-source-selection-final-20260909/{2026-08-26,2026-09-02,2026-09-09}/`. 각 summary/validation/report 보존. 598/581/431개 원문 레코드 중 17/17/15개를 선택; 각 blocking 오류 0, Notion 생략 경고 161/107/171. 오늘 기존 draft는 장식 오탐 수정 후에도 `fact_subject_mismatch` 9건.
- 09-09 사고의 원문 5개 문장 모두를 선택하고 highlight를 켠 별도 회귀 테스트도 PASS. 단순히 사고 항목을 생략해서 통과한 것만은 아니다.
- 재생은 결정적 원문 발췌본의 검증이다. live git 상태 확인·실제 AI 선택 품질·게시 성공은 검증하지 않았다. cron 전환, 실제 AI 호출, 커밋/병합/PR/게시를 실행하지 않았다.
- 후속 사용자 선택 `2`로 커밋·push·PR 생성이 승인됐다. PR은 기본 브랜치 `main` 대상이며, 기존 핸드오프 전용 PR #70의 커밋은 제외한다. 운영 크론 전환·Redmine 게시는 이 승인에 포함되지 않는다.
- PR tribunal 1차: 부모 문단이 목록 사이/뒤에 있을 때의 조건 손실(A/B HIGH), 분할 UTF-8 stdout 손상(B MEDIUM)을 재현했다. 부모 문단 소유권과 스트림 디코딩을 수정하고, 모호한 내어쓰기는 거부한다. 과거 08-26 자료에 존재하는 collector `↳` 부가 설명의 커밋 소유권은 유지한다. 각 회귀 테스트의 수정 전 실패와 수정 후 통과를 확인했으며, 세 과거 재생 결과의 보고서 hash도 유지됐다.
