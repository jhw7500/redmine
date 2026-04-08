# Plan: weekly-report-v2

> **Summary**: Git + Notion + CC 세션 멀티소스 주간 보고 자동화
>
> **Project**: redmine
> **Author**: Claude Code
> **Date**: 2026-04-08
> **Status**: Draft

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | Git 커밋에 안 남는 작업(회의, 리서치, 설계, 소통)이 주간 보고에 누락됨. git 없는 프로젝트/비개발 업무는 보고 불가 |
| **Solution** | 기존 git collector에 Notion AI Workspace + CC 세션 이력 collector를 추가하여 3개 소스 통합 보고서 생성 |
| **Function/UX Effect** | 기존과 동일한 `node index.js generate` 실행만으로 개발+비개발 업무가 모두 포함된 보고서 자동 생성 |
| **Core Value** | 주간 보고의 완전성 — 실제 수행한 모든 업무가 빠짐없이 반영되는 보고서 |

---

## Context Anchor

| 축 | 내용 |
|----|------|
| **WHY** | Git 커밋만으로는 실제 업무의 60~70%만 반영됨. 나머지 30~40%(회의, 조사, 설계, Notion 기록, CC 세션 작업)이 누락 |
| **WHO** | 조현우 (1인 사용) |
| **RISK** | Notion API 속도/할당량, CC 세션 검색 정확도, 기존 git 파이프라인 깨짐 |
| **SUCCESS** | 3개 소스 통합 보고서 생성, 기존 git 전용 출력과 호환, 소스 추가 시 설정 1곳 수정 |
| **SCOPE** | collector 확장 (Notion + CC 세션) + 통합 렌더링 + 설정 확장 |

---

## 1. Overview

### 1.1 Purpose

주간 업무 보고에서 git 커밋에 반영되지 않는 업무(회의, 리서치, 설계 논의, Notion 메모 등)를 자동으로 수집하여 보고서 완전성을 높인다.

### 1.2 Background

- v1(redmine-report)은 git 커밋 기반 수집 → 번역 → AI 요약 → Redmine 위키 업데이트로 안정 운영 중 (Match Rate 98.9%)
- 그러나 실제 업무 중 커밋으로 남지 않는 활동이 상당수:
  - Notion AI Workspace에 기록하는 프로젝트 활동, 기술 메모
  - Claude Code 세션에서 수행하는 조사, 설계, 코드 리뷰, 디버깅
- 이러한 활동이 주간 보고에 누락되어 업무 가시성이 떨어짐

### 1.3 Related Documents

- v1 Plan: `/home/jhw/ai/opencode/projects/redmine/docs/01-plan/features/redmine-report.plan.md`
- v1 Design: `/home/jhw/ai/opencode/projects/redmine/docs/02-design/features/redmine-report.design.md`
- v1 Report: `/home/jhw/ai/opencode/projects/redmine/docs/04-report/features/redmine-report.report.md`

---

## 2. Scope

### 2.1 In Scope

- [ ] Notion collector: Projects + Knowledge Base에서 주간 활동 수집
- [ ] CC 세션 collector: episodic-memory 검색으로 주간 작업 내용 추출, 프로젝트별 그룹핑
- [ ] 통합 렌더링: 3개 소스를 기존 Redmine 위키 템플릿에 병합
- [ ] 설정 확장: `repo-config.json`에 Notion/세션 소스 설정 추가
- [ ] 기존 git collector 100% 호환 유지

### 2.2 Out of Scope

- Notion에 직접 쓰기 (읽기 전용)
- 이메일/메신저 등 추가 소스 (향후 확장 가능하나 이번 범위 아님)
- Redmine 위키 템플릿 구조 변경 (기존 섹션 구조 유지)
- 웹 UI/대시보드

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | 요구사항 | 우선순위 | 상태 |
|----|----------|----------|------|
| FR-01 | Notion AI Workspace에서 지난 1주일간 Projects 활동 수집 | High | Pending |
| FR-02 | Notion Knowledge Base에서 지난 1주일간 신규/수정 항목 수집 | High | Pending |
| FR-03 | CC 세션 이력에서 지난 1주일간 작업 내용을 프로젝트별로 그룹핑하여 추출 | High | Pending |
| FR-04 | 3개 소스 데이터를 기존 카테고리 체계(PIM/Wireless/ETC)에 매핑 | High | Pending |
| FR-05 | 기존 git 전용 모드 유지 (`--git-only` 또는 설정으로 소스 선택) | Medium | Pending |
| FR-06 | 소스별 수집 결과를 개별 확인 가능 (디버깅/검증용) | Medium | Pending |
| FR-07 | Notion/세션 소스 비활성화 시 기존 v1과 동일하게 동작 | High | Pending |

### 3.2 Non-Functional Requirements

| 카테고리 | 기준 | 측정 방법 |
|----------|------|-----------|
| 성능 | 전체 수집 3분 이내 (git + Notion + 세션) | time 명령 |
| 안정성 | 개별 소스 실패 시 나머지 소스로 계속 진행 | 소스별 try-catch |
| 호환성 | 기존 cron 스크립트(`run-*-env.sh`) 수정 없이 동작 | cron 실행 테스트 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] SC-01: `node index.js generate`로 3개 소스 통합 보고서 생성 확인
- [ ] SC-02: Notion 소스 비활성화 시 기존 v1과 동일한 출력
- [ ] SC-03: 개별 소스 장애 시 나머지 소스로 정상 생성 (graceful degradation)
- [ ] SC-04: 기존 cron 스크립트 수정 없이 동작
- [ ] SC-05: 새 소스 추가 시 `repo-config.json` 수정만으로 완료

---

## 5. Risks and Mitigation

| 리스크 | 영향 | 가능성 | 완화 방안 |
|--------|------|--------|-----------|
| Notion API 속도/할당량 초과 | Medium | Low | 캐싱 + 날짜 범위 필터로 최소 요청 |
| CC episodic-memory 검색 부정확 | Medium | Medium | 키워드 + 날짜 범위 조합 검색, 결과 후처리로 노이즈 제거 |
| 기존 git 파이프라인 깨짐 | High | Low | git collector 코드 변경 최소화, 신규 collector를 별도 함수로 분리 |
| Notion MCP 서버 미실행 시 | Medium | Medium | 소스별 가용성 체크 후 건너뛰기 (graceful skip) |
| CC 세션과 git 커밋 내용 중복 | Low | High | 중복 제거 로직: git에 이미 있는 항목은 세션 결과에서 제외 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| 리소스 | 타입 | 변경 내용 |
|--------|------|-----------|
| `repo-config.json` | Config | `sources` 섹션 추가 (Notion/세션 설정) |
| `lib/collector.js` | Module | `collectFromNotion()`, `collectFromSessions()` 함수 추가 |
| `lib/publisher.js` | Module | 통합 데이터 렌더링 로직 확장 |
| `index.js` | Entry | 소스 오케스트레이션 로직 추가 |

### 6.2 Current Consumers

| 리소스 | 사용처 | 영향 |
|--------|--------|------|
| `repo-config.json` | `lib/config.js` → `loadConfig()` | 하위 호환 유지 (신규 필드 optional) |
| `lib/collector.js` | `index.js` → `collectAll()` | 반환 형식 확장 (기존 필드 유지) |
| `lib/publisher.js` | `index.js` → `generate()`, `update()` | 입력 데이터 확장 (기존 호환) |
| `run-generate-env.sh` | cron | 변경 없음 |
| `run-update-env.sh` | cron | 변경 없음 |

### 6.3 Verification

- [ ] `loadConfig()` 기존 필드 모두 정상 로드
- [ ] `collectAll()` git 전용 결과와 하위 호환
- [ ] cron 스크립트 변경 없이 동작

---

## 7. Architecture Considerations

### 7.1 Project Level

| Level | Selected |
|-------|:--------:|
| **Starter** | **v** |

Node.js CLI 스크립트. 프레임워크 없음. 기존 v1 구조 확장.

### 7.2 Key Architectural Decisions

| 결정 | 옵션 | 선택 | 근거 |
|------|------|------|------|
| v1 관계 | 확장 / 교체 / 병행 | **확장** | v1 모듈 구조가 이미 적합, 재사용 극대화 |
| Notion 접근 | MCP 도구 / REST API 직접 | **MCP 도구** | `notion-search` MCP 이미 사용 가능, 인증 별도 불필요 |
| CC 세션 접근 | episodic-memory MCP / 파일 직접 읽기 | **episodic-memory MCP** | 시맨틱 검색 지원, 프로젝트별 필터 가능 |
| 소스 통합 방식 | 수집 후 합산 / 소스별 독립 섹션 | **수집 후 합산** | 기존 카테고리(PIM/Wireless/ETC)에 자연스럽게 병합 |
| 중복 제거 | 키워드 매칭 / AI 기반 | **키워드 매칭** | 단순하고 예측 가능, 1인 사용이라 정밀도 충분 |
| 실행 환경 | CLI 직접 / CC 세션 내 | **CC 세션 내** | Notion MCP, episodic-memory MCP 모두 CC 세션에서만 접근 가능 |

### 7.3 Architecture Overview

```
index.js (오케스트레이션)
  ├── lib/config.js        (설정 로드 — sources 설정 추가)
  ├── lib/collector.js     (기존 git 수집 유지)
  │     ├── collectFromGit()      — 기존 로직 그대로
  │     ├── collectFromNotion()   — NEW: Notion MCP 검색
  │     └── collectFromSessions() — NEW: episodic-memory 검색
  ├── lib/merger.js        (NEW: 소스 통합 + 중복 제거 + 카테고리 매핑)
  └── lib/publisher.js     (기존 렌더링 + Redmine API 유지)
```

---

## 8. Data Source Details

### 8.1 Git (기존)

- **수집 방법**: `git log --since --until` per repo
- **데이터**: 커밋 메시지, PR 제목/리뷰
- **출력**: 카테고리별 커밋 목록 + AI 요약
- **변경 없음**

### 8.2 Notion AI Workspace (신규)

- **수집 방법**: `notion-search` MCP 도구로 날짜 범위 검색
- **대상 DB**:
  - **Projects**: `created_date_range` 필터로 주간 활동 수집
  - **Knowledge Base**: 신규/수정 기술 메모 수집
- **출력**: 프로젝트명 + 활동 요약 목록
- **카테고리 매핑**: Notion 프로젝트명 → `repo-config.json` 카테고리로 매핑

### 8.3 CC 세션 (신규)

- **수집 방법**: `episodic-memory search` MCP 도구
- **검색 전략**: 프로젝트명 키워드 + 날짜 범위 (`after`/`before`)
- **출력**: 프로젝트별 그룹핑된 작업 요약
- **중복 처리**: git 커밋과 겹치는 내용은 제외 (커밋 메시지 키워드 매칭)

---

## 9. Configuration Extension

### 9.1 repo-config.json 확장

```json
{
  "sources": {
    "git": { "enabled": true },
    "notion": {
      "enabled": true,
      "databases": ["Projects", "Knowledge Base"],
      "projectMapping": {
        "max9296": "pimDriver",
        "pim-package": "pimApp",
        "wlan-driver": "wlanNxp"
      }
    },
    "session": {
      "enabled": true,
      "keywords": ["max9296", "pim", "wlan", "redmine", "automation"],
      "maxResults": 20
    }
  },
  "repos": { ... }
}
```

### 9.2 Environment Variables

| 변수 | 용도 | 필수 | 기존 |
|------|------|:----:|:----:|
| `REDMINE_API_KEY` | Redmine API 인증 | Yes | Yes |
| `GITHUB_TOKEN` | GitHub PR 조회 | Yes | Yes |
| `CLAUDE_CLI` | Claude CLI 경로 | No | Yes |
| (없음 — MCP 도구 사용) | Notion 접근 | — | — |
| (없음 — MCP 도구 사용) | CC 세션 접근 | — | — |

> Notion과 CC 세션은 MCP 도구를 통해 접근하므로 별도 API 키 불필요.

---

## 10. Execution Constraint

**중요**: Notion MCP와 episodic-memory MCP는 Claude Code 세션 내에서만 사용 가능합니다.

따라서 실행 방식이 두 가지로 나뉩니다:

| 모드 | 실행 방법 | 소스 |
|------|-----------|------|
| **Full** (CC 세션 내) | `/redmine-report` 스킬 또는 CC 내 `node index.js` | Git + Notion + CC 세션 |
| **Git-only** (cron/터미널) | `bash run-generate-env.sh` | Git만 |

- cron은 기존처럼 git-only로 동작 (Notion/세션 소스 자동 skip)
- CC 세션 내 실행 시 MCP 도구 사용 가능하면 자동으로 full 모드

---

## 11. Next Steps

1. [ ] Design 문서 작성 (`weekly-report-v2.design.md`)
2. [ ] 구현
3. [ ] Gap analysis

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-08 | Initial draft | Claude Code |
