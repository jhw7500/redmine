# Design: weekly-report-v2

> **Summary**: Git + Notion + CC 세션 멀티소스 주간 보고 자동화
>
> **Project**: redmine
> **Author**: Claude Code
> **Date**: 2026-04-08
> **Status**: Draft
> **Planning Doc**: [weekly-report-v2.plan.md](../01-plan/features/weekly-report-v2.plan.md)

---

## Context Anchor

| 축 | 내용 |
|----|------|
| **WHY** | Git 커밋만으로 업무의 60~70%만 반영, 나머지(회의, 조사, 설계, Notion 기록, CC 세션 작업) 누락 |
| **WHO** | 조현우 (1인 사용) |
| **RISK** | Notion API 속도/할당량, CC 세션 검색 정확도, 기존 git 파이프라인 깨짐 |
| **SUCCESS** | 3개 소스 통합 보고서 생성, 기존 호환, 소스 추가 시 설정 1곳 수정 |
| **SCOPE** | collector 확장 (Notion + CC 세션) + merger 신규 + 설정 확장 |

---

## 1. Overview

### 1.1 Design Goals

- 기존 git collector를 변경하지 않고 Notion/세션 collector를 추가
- 3개 소스 데이터를 기존 카테고리 체계(PIM/Wireless/ETC)에 통합
- 개별 소스 장애 시 나머지로 정상 동작 (graceful degradation)
- CC 세션 외부(cron)에서는 자동으로 git-only 모드

### 1.2 Design Principles

- **기존 코드 불변**: `collector.js`, `publisher.js` 핵심 로직 변경 최소화
- **소스 독립성**: 각 collector는 독립적으로 동작, 실패해도 다른 소스에 영향 없음
- **설정 기반**: 소스 활성화/비활성화를 `repo-config.json`으로 제어

---

## 2. Architecture

### 2.0 Architecture Comparison

| 기준 | Option A: 최소 변경 | Option B: Clean 분리 | Option C: 실용적 균형 |
|------|:-:|:-:|:-:|
| **접근** | collector.js에 모든 소스 추가 | 소스별 별도 파일 + 기존 분해 | 기존 유지 + 신규 파일 추가 |
| **신규 파일** | 0 | 5 | 3 |
| **수정 파일** | 2 (collector, config) | 5 | 3 (index, config, repo-config) |
| **복잡도** | Low | High | Medium |
| **유지보수** | Medium (비대화) | High | High |
| **리스크** | git 로직 변경 위험 | 기존 코드 분해 위험 | Low (기존 불변) |

**Selected**: Option C — **Rationale**: 기존 collector.js(463줄)를 변경하지 않으면서 관심사를 분리. v1에서 검증된 git 수집 파이프라인을 보호.

### 2.1 Component Diagram

```
index.js (오케스트레이션)
  │
  ├── lib/config.js           (설정 로드 — sources 추가)
  │
  ├── lib/collector.js        (기존 git 수집 — 변경 없음)
  │     └── collectAll()      → { "{{PIM_APPLICATION_KO}}": "...", ... }
  │
  ├── lib/notion-collector.js  (NEW — Notion MCP 수집)
  │     └── collectFromNotion() → [ { project, category, items[] } ]
  │
  ├── lib/session-collector.js (NEW — CC 세션 수집)
  │     └── collectFromSessions() → [ { project, category, items[] } ]
  │
  ├── lib/merger.js            (NEW — 소스 통합 + 중복 제거)
  │     └── mergeIntoAutoContent(gitResult, notionItems, sessionItems, config)
  │           → { "{{PIM_APPLICATION_KO}}": "...", ... }  (기존 형식 유지)
  │
  └── lib/publisher.js         (기존 렌더링 — 변경 없음)
        └── generate() / update()  ← autoContent 그대로 소비
```

### 2.2 Data Flow

```
                    ┌─────────────────┐
                    │   repo-config   │
                    │   .json         │
                    └────────┬────────┘
                             │ loadConfig()
                             ▼
               ┌─────────────────────────┐
               │      index.js           │
               │   (오케스트레이션)         │
               └─────┬──────┬──────┬─────┘
                     │      │      │
          ┌──────────┘      │      └──────────┐
          ▼                 ▼                  ▼
   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
   │ collector.js │  │ notion-      │  │ session-     │
   │ (git)        │  │ collector.js │  │ collector.js │
   └──────┬──────┘  └──────┬───────┘  └──────┬───────┘
          │                │                  │
          │ gitResult      │ notionItems      │ sessionItems
          │ (기존 형식)     │ (통일 형식)       │ (통일 형식)
          └────────┬───────┴──────────────────┘
                   ▼
          ┌────────────────┐
          │   merger.js    │
          │ (통합+중복제거)  │
          └────────┬───────┘
                   │ autoContent (기존 형식)
                   ▼
          ┌────────────────┐
          │ publisher.js   │
          │ (렌더링+API)    │
          └────────────────┘
```

### 2.3 Dependencies

| 컴포넌트 | 의존 대상 | 용도 |
|----------|----------|------|
| notion-collector.js | Notion MCP (`notion-search`) | Workspace 검색 |
| session-collector.js | episodic-memory MCP (`search`) | CC 세션 이력 검색 |
| merger.js | config (categories, repos) | 카테고리 매핑 + 중복 제거 |
| index.js | 모든 모듈 | 오케스트레이션 |

---

## 3. Data Model

### 3.1 소스별 수집 결과 형식

```javascript
// git collector 출력 (기존, 변경 없음)
// collectAll() → { "{{PIM_APPLICATION_KO}}": "렌더링된 문자열", ... }

// Notion/Session collector 출력 (통일 형식)
// → Array<CollectedItem>
/**
 * @typedef {Object} CollectedItem
 * @property {string} project   - 프로젝트명 (예: "max9296", "pim-check")
 * @property {string} category  - 카테고리 키 (예: "pimDriver", "etc")
 * @property {string} source    - 소스 식별 ("notion" | "session")
 * @property {string[]} items   - 활동 항목 목록
 */
```

### 3.2 merger 입출력

```javascript
// 입력
mergeIntoAutoContent(
  gitResult,      // { "{{PIM_APPLICATION_KO}}": "...", ... }
  notionItems,    // CollectedItem[]
  sessionItems,   // CollectedItem[]
  config          // loadConfig() 결과
)

// 출력: 기존과 동일한 형식 (publisher.js 호환)
// → { "{{PIM_APPLICATION_KO}}": "...", ... }
```

---

## 4. Module Specification

### 4.1 config.js 변경

**변경 범위**: `loadConfig()` 함수에 `sources` 설정 로드 추가

```javascript
// 추가할 부분 (기존 코드 뒤에)
const sources = raw.sources || {
  git: { enabled: true },
  notion: { enabled: false },
  session: { enabled: false }
};

// 반환 객체에 sources 추가
return { ..., sources };
```

**하위 호환**: `sources` 필드가 없는 기존 `repo-config.json`에서도 기본값으로 동작 (git만 활성화)

### 4.2 notion-collector.js (NEW)

```javascript
/**
 * Notion AI Workspace에서 주간 활동 수집
 *
 * @param {Object} config - loadConfig() 결과
 * @param {string} startDate - 시작일 (YYYY-MM-DD)
 * @param {string} endDate - 종료일 (YYYY-MM-DD)
 * @returns {Promise<CollectedItem[]>}
 */
async function collectFromNotion(config, startDate, endDate) {
  // 1. config.sources.notion 확인 → disabled면 빈 배열 반환
  // 2. notion-search MCP 도구로 Projects DB 검색
  //    - query: 프로젝트명 키워드
  //    - filters: { created_date_range: { start_date, end_date } }
  // 3. notion-search MCP 도구로 Knowledge Base DB 검색
  // 4. 결과를 CollectedItem[] 형식으로 변환
  //    - 프로젝트명 → config.sources.notion.projectMapping으로 카테고리 매핑
  //    - 매핑 안 되는 항목 → "etc" 카테고리
  // 5. 반환
}
```

**MCP 도구 호출 방식**: 이 모듈은 CC 세션 내에서만 실행됨. MCP 도구는 CC 세션이 제공하는 컨텍스트에서 호출.

**실행 환경 제약**: `notion-collector.js`는 독립 Node.js 프로세스에서 직접 실행할 수 없음. CC 세션의 `/redmine-report` 스킬에서 호출되는 구조.

> **설계 결정**: Notion/세션 수집은 Node.js 모듈이 아닌, CC 스킬(`/redmine-report`)의 로직으로 구현한다. 스킬이 MCP 도구를 호출하여 데이터를 수집하고, 결과를 JSON 파일로 저장한 뒤 `index.js`가 읽는 방식.

### 4.3 session-collector.js (NEW)

```javascript
/**
 * CC 세션 이력에서 주간 작업 내용 추출
 *
 * @param {Object} config - loadConfig() 결과
 * @param {string} startDate - 시작일 (YYYY-MM-DD)
 * @param {string} endDate - 종료일 (YYYY-MM-DD)
 * @returns {Promise<CollectedItem[]>}
 */
async function collectFromSessions(config, startDate, endDate) {
  // 1. config.sources.session 확인 → disabled면 빈 배열 반환
  // 2. config.sources.session.keywords 순회
  //    - 각 키워드로 episodic-memory search 호출
  //    - after: startDate, before: endDate
  //    - limit: config.sources.session.maxResults || 20
  // 3. 결과를 프로젝트별로 그룹핑
  //    - 키워드 = 프로젝트명 → repos에서 카테고리 매핑
  // 4. 각 세션 결과에서 핵심 작업 내용 1줄 추출
  // 5. CollectedItem[] 반환
}
```

**실행 환경 제약**: notion-collector와 동일. CC 스킬에서 MCP 도구 호출 후 JSON 파일로 저장.

### 4.4 실제 실행 아키텍처 (MCP 제약 반영)

```
CC 세션 내 (/redmine-report 스킬)
  │
  ├─ 1. Notion MCP 호출 → 결과를 out/notion-items.json 저장
  ├─ 2. episodic-memory MCP 호출 → 결과를 out/session-items.json 저장
  └─ 3. node index.js generate 실행
         │
         ├── collector.js: git 커밋 수집
         ├── merger.js: git + notion-items.json + session-items.json 통합
         └── publisher.js: 렌더링 + Redmine API

cron (CC 세션 외부)
  │
  └─ bash run-generate-env.sh
         │
         └── node index.js generate
               ├── collector.js: git 커밋 수집
               ├── merger.js: JSON 파일 없음 → git-only (기존과 동일)
               └── publisher.js: 렌더링 + Redmine API
```

### 4.5 merger.js (NEW)

```javascript
/**
 * 3개 소스 통합 + 중복 제거 + 카테고리 매핑
 *
 * @param {Object} gitResult - collectAll() 결과 (기존 형식)
 * @param {string} notionPath - out/notion-items.json 경로 (없으면 skip)
 * @param {string} sessionPath - out/session-items.json 경로 (없으면 skip)
 * @param {Object} config - loadConfig() 결과
 * @returns {Object} - 기존 autoContent 형식
 */
function mergeIntoAutoContent(gitResult, notionPath, sessionPath, config) {
  // 1. JSON 파일 로드 (없으면 빈 배열)
  const notionItems = loadJsonSafe(notionPath);  // CollectedItem[]
  const sessionItems = loadJsonSafe(sessionPath); // CollectedItem[]

  // 2. 비어있으면 gitResult 그대로 반환 (기존 호환)
  if (!notionItems.length && !sessionItems.length) return gitResult;

  // 3. 카테고리별로 Notion/세션 항목을 기존 gitResult에 추가
  //    - CollectedItem.category → config.categories[cat].templateKey
  //    - 해당 templateKey의 기존 문자열에 항목 추가
  //    - source 표시: "[Notion]" 또는 "[CC]" 접두사

  // 4. 중복 제거
  //    - git 커밋 메시지 키워드와 Notion/세션 항목 비교
  //    - 유사도 높은 항목 제거 (normalizeForDedup 활용)

  // 5. gitResult와 동일한 형식으로 반환
}

function loadJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return []; }
}
```

### 4.6 index.js 변경

```javascript
// 기존
const autoContent = await collectAll(config, startDate, endDate);

// 변경 후
const gitResult = await collectAll(config, startDate, endDate);
const autoContent = mergeIntoAutoContent(
  gitResult,
  path.join(config.env.outputDir, 'notion-items.json'),
  path.join(config.env.outputDir, 'session-items.json'),
  config
);
```

**변경량**: 3줄 추가, 1줄 수정. publisher.js 변경 없음.

---

## 5. Configuration Extension

### 5.1 repo-config.json 변경

기존 최상위에 `sources` 섹션 추가:

```json
{
  "sources": {
    "git": { "enabled": true },
    "notion": {
      "enabled": true,
      "databases": ["Projects", "Knowledge Base"],
      "projectMapping": {
        "max9296": "pimDriver",
        "MAX9296 GMSL2": "pimDriver",
        "pim-package": "pimApp",
        "pim-check": "pimTest",
        "wlan-driver": "wlanNxp",
        "wlan-package": "wlanNxp",
        "redmine": "etc",
        "automation": "etc",
        "email-mcp": "etc",
        "cts-ta": "etc",
        "pcap-analyzer": "etc",
        "wifi-sniff": "wlanNxp"
      }
    },
    "session": {
      "enabled": true,
      "keywords": [
        "max9296", "gstApp", "streamApp", "pim-package", "pim-check",
        "wlan-driver", "wlan-package", "wlan-bridge", "wpa-supplicant",
        "sc16is7xx", "redmine", "automation", "cts-ta", "cts-email",
        "pcap-analyzer", "wifi-sniff"
      ],
      "maxResults": 10
    }
  },
  "repos": { ... },
  "categories": { ... },
  ...
}
```

### 5.2 하위 호환

- `sources` 필드 없는 기존 config → `config.js`에서 기본값 적용 (git만 활성화)
- `notion-items.json` / `session-items.json` 없음 → `merger.js`에서 빈 배열 처리
- 결과: 기존 cron 동작 100% 유지

---

## 6. /redmine-report 스킬 확장

### 6.1 현재 스킬 동작

```
/redmine-report → node index.js generate → (확인) → node index.js update
```

### 6.2 확장 후 동작

```
/redmine-report
  ├── 1. Notion MCP 수집 → out/notion-items.json 저장
  ├── 2. episodic-memory 수집 → out/session-items.json 저장
  └── 3. node index.js generate (merger가 JSON 파일 읽어서 통합)
       → (확인) → node index.js update
```

### 6.3 스킬 수집 로직 상세

**Notion 수집**:
```
1. notion-search(query: "프로젝트명", filters: { created_date_range })
2. 결과에서 title, 활동 내용 추출
3. projectMapping으로 카테고리 매핑
4. CollectedItem[] → out/notion-items.json
```

**세션 수집**:
```
1. episodic-memory search(query: "키워드", after: startDate, before: endDate)
2. 프로젝트별 그룹핑
3. 각 세션에서 핵심 작업 1줄 추출
4. CollectedItem[] → out/session-items.json
```

---

## 7. Error Handling

| 상황 | 처리 |
|------|------|
| Notion MCP 미연결/실패 | `notion-items.json` 미생성 → merger가 skip, console.warn |
| episodic-memory 미연결/실패 | `session-items.json` 미생성 → merger가 skip, console.warn |
| JSON 파일 파싱 실패 | `loadJsonSafe()` → 빈 배열 반환, console.warn |
| 프로젝트 카테고리 매핑 실패 | "etc" 카테고리로 할당 |
| CC 세션 외부 실행 (cron) | JSON 파일 없음 → git-only 자동 동작 |

---

## 8. Test Plan

### 8.1 Test Scope

| 유형 | 대상 | 방법 | 단계 |
|------|------|------|------|
| 단위 | merger.js 로직 | 수동 테스트 (샘플 JSON) | Do |
| 통합 | 3개 소스 통합 | `/redmine-report` 실행 | Do |
| 회귀 | git-only 동작 | `bash run-generate-env.sh` | Do |

### 8.2 검증 시나리오

| # | 시나리오 | 입력 | 기대 결과 |
|---|----------|------|-----------|
| 1 | git-only (기존 호환) | JSON 파일 없음 | v1과 동일한 출력 |
| 2 | git + Notion | notion-items.json 존재 | Notion 항목이 해당 카테고리에 추가 |
| 3 | git + 세션 | session-items.json 존재 | 세션 항목이 해당 카테고리에 추가 |
| 4 | 3개 소스 통합 | 모든 JSON 존재 | 3개 소스 통합, 중복 제거 |
| 5 | 소스 비활성화 | sources.notion.enabled=false | Notion 수집 건너뛰기 |
| 6 | 중복 제거 | git 커밋과 세션 항목 겹침 | 중복 항목 1개만 유지 |

---

## 9. Implementation Guide

### 9.1 File Structure

```
projects/redmine/
├── index.js                      (수정: merger 호출 추가)
├── lib/
│   ├── config.js                 (수정: sources 로드 추가)
│   ├── collector.js              (변경 없음)
│   ├── notion-collector.js       (NEW: ~80줄)
│   ├── session-collector.js      (NEW: ~80줄)
│   ├── merger.js                 (NEW: ~120줄)
│   └── publisher.js              (변경 없음)
├── repo-config.json              (수정: sources 섹션 추가)
└── out/
    ├── notion-items.json         (런타임 생성, gitignore)
    └── session-items.json        (런타임 생성, gitignore)
```

### 9.2 Implementation Order

1. [ ] `repo-config.json`에 `sources` 섹션 추가
2. [ ] `lib/config.js` — sources 로드 로직 추가
3. [ ] `lib/merger.js` — 소스 통합 모듈 작성
4. [ ] `lib/notion-collector.js` — Notion 수집 모듈 작성
5. [ ] `lib/session-collector.js` — 세션 수집 모듈 작성
6. [ ] `index.js` — merger 호출 연결
7. [ ] `/redmine-report` 스킬 — MCP 수집 → JSON 저장 로직 추가
8. [ ] 테스트: git-only 회귀 확인
9. [ ] 테스트: 3개 소스 통합 확인

### 9.3 Session Guide

#### Module Map

| Module | Scope Key | 설명 | 예상 턴 |
|--------|-----------|------|:-------:|
| 설정 + Merger | `module-1` | repo-config.json, config.js, merger.js | 15-20 |
| Collectors | `module-2` | notion-collector.js, session-collector.js | 15-20 |
| 통합 + 스킬 | `module-3` | index.js 연결, /redmine-report 스킬 확장 | 15-20 |
| 테스트 + 검증 | `module-4` | 회귀 테스트, 통합 테스트 | 10-15 |

#### Recommended Session Plan

| 세션 | 단계 | Scope | 턴 |
|------|------|-------|:--:|
| 세션 1 | Plan + Design | 전체 | 30-35 |
| 세션 2 | Do | `--scope module-1,module-2` | 30-40 |
| 세션 3 | Do | `--scope module-3,module-4` | 25-35 |
| 세션 4 | Check + Report | 전체 | 20-30 |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-08 | Initial draft | Claude Code |
