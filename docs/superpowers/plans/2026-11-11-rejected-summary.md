# 검증 실패 요약본 우선 게시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 검증 오류가 있어도 전체 팀 요약본을 보존하고 원문보다 우선 게시한다.

**Architecture:** 팀 요약본에만 `retainRejectedSummary`를 활성화한다. 프로젝트 구조 검사는 유지하며 사실·출처 검증 오류 뒤에도 생성을 계속한다. 기존 최종 검증과 거부 보고서 게시 경로를 재사용한다.

**Tech Stack:** Node 18+, CommonJS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-11-rejected-summary-design.md`

## Global Constraints

- 새 의존성, 실제 AI 호출, Redmine·Slack 쓰기, 보존 산출물 변경을 하지 않는다.
- 일반 생성은 첫 프로젝트 검증 오류에서 계속 중단한다.
- 구조 오류·AI 호출 실패·증거 손상과 이미 게시된 영수증의 교체는 허용하지 않는다.
- 사용자 승인 없는 커밋·PR·Task 생성은 하지 않는다.

## Review Focus

- 첫 프로젝트 검증 오류 후 다른 프로젝트까지 생성하고 거부 보고서에 포함하는가.
- 구조 오류와 응답 없음은 요약본 대신 정상 대체 보고서로 이어지는가.
- 정상 depth2가 있어도 검증 실패 요약본을 먼저 선택하는가.
- 실패 요약본 재실행이 중복 게시 없이 끝나고 기존 depth2 영수증 교체는 거부되는가.
- 요약본 파일의 경로·해시·단일 헤더 검사가 유지되는가.

### Task 1: 실패한 팀 요약본의 전체 생성

**Files:** `index.js`, `lib/publisher.js`, `lib/report-generation-plan.js`, `lib/__tests__/report-generate-v2.test.js`.

**Interfaces:** `config.env.retainRejectedSummary === true`를 `generateContent`의 `retainInvalidProjectOutputs` 옵션으로 전달한다. `validateProjectOutput`은 이 옵션에서 사실·출처 오류를 `status: "FAIL"`로 반환한다. 구조 오류는 계속 throw한다. 최종 검증 결과와 거부 보고서 계약은 유지한다.

- [x] 거부 요약본의 프로젝트 전체 생성·검증 기록 보존, 구조 오류·응답 없음 차단을 검증하는 테스트를 먼저 작성한다.
- [x] `node --test lib/__tests__/report-generate-v2.test.js`에서 새 동작의 실패를 확인한다.
- [x] 옵션 전달과 사실·출처 검증 실패 처리만 수정한다.
- [x] 같은 테스트 명령이 통과하고 일반 생성의 기존 중단 테스트도 통과하는지 확인한다.

### Task 2: 실패 요약본 우선 선택과 게시 증거

**Files:** `lib/weekly-report-pair.js`, `lib/__tests__/weekly-report-pair.test.js`.

**Interfaces:** 팀 요약본 설정에서만 Task 1의 boolean을 켠다. 기존 `rejectedSummary`와 `hasSingleSection`으로 후보를 검증하고, 정상 depth2/depth3보다 먼저 선택한다. `rejected_published`·해시·복구 영수증 계약은 유지한다.

- [x] 실제 pair 준비부터 요약본 거부 보존·우선 게시·검토 블록·재실행 방지까지 회귀 테스트를 먼저 작성한다.
- [x] `node --test lib/__tests__/weekly-report-pair.test.js`에서 새 동작의 실패를 확인한다.
- [x] 요약본 설정과 auto 선택 순서를 수정하고 바뀐 우선순위의 기존 테스트를 갱신한다.
- [x] 위 테스트와 두 파일의 결합 테스트가 통과하는지 확인한다.

### Task 3: 검증과 리뷰

- [x] `node --test lib/__tests__/*.test.js` 전체 실행·통과·실패·skip 수를 확인한다.
- [x] 변경 JS의 `node --check`와 `git diff --check`를 실행한다.
- [x] 별도 리뷰어가 코드·테스트·영수증 복구 경계를 검토한다.
- [x] 결과와 운영 반영 전 상태, 실제 재게시가 없었음을 보고한다.
