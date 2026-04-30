# jhw-notion ↔ redmine 정합성 매핑

- **작성일**: 2026-04-30
- **목적**: 두 프로젝트가 동일한 Notion DB를 다른 책임으로 사용 — 매핑/스키마 동기화 가이드.

## 1. 두 프로젝트의 책임

| 프로젝트 | 책임 | 핵심 파일 |
|---|---|---|
| **jhw-notion** | Notion DB 쓰기 (record/note/start/close) + 읽기 (search/context/recall/report) | `mcp-server/src/schema.ts`, `config.ts`, `tools/*.ts` |
| **redmine** | Notion DB 읽기 → 주간 보고서 생성 → Redmine wiki 발행 | `lib/collect-notion-api.js`, `repo-config.json` |

→ Notion DB는 단일 (운영 5개), 두 프로젝트가 동일 DB를 다른 방향으로 다룬다.

## 2. 정합성 critical 요소

### 2.1 DB ID
| DB | jhw-notion (`config.ts`) | redmine (`collect-notion-api.js DATABASES`) |
|---|---|---|
| projects | `4430fcd4-…883` | ✅ 동일 |
| preferences | `4e5ba7f0-…f57` | ✅ `aiPreferences` 키로 동일 |
| decisionLog | `6c9fbc24-…cfd` | ✅ 동일 |
| knowledgeBase | `ec68d6c6-…461` | ✅ 동일 |
| references | `979a9412-…505` | ✅ 동일 |

→ DB ID는 양쪽에 hard-coded. 변경 시 양쪽 모두 수정 필요.

### 2.2 project 필드 타입
- jhw-notion P0-1: **relation** (target=projects DB)
- redmine: **relation 우선 + rich_text fallback** (`resolveProjectText`, P0-1 fix 후)

→ jhw-notion에서 schema 변경 시 redmine `resolveProjectText`도 갱신 필요.

### 2.3 report select 옵션
- jhw-notion `REPORT_VALUES` (config.ts, kebab-case 10개):
  ```
  pim-app, pim-driver-cam, pim-driver-spi, pim-test,
  wlan-bsp, wlan-app, wlan-driver, wlan-test, etc, none
  ```
- redmine `reportCategoryMapping` (repo-config.json, P2-A 외부화):
  - 9개 옵션 → camelCase category (`pim-app→pimApp`, ...)
  - `none`은 `reportSkipValues`로 분리 (보고서 제외)

→ **신규 select 옵션 추가 시 양쪽 동기화 필요**:
1. jhw-notion `mcp-server/src/config.ts` `REPORT_VALUES` 배열에 추가
2. redmine `repo-config.json` `sources.notion.reportCategoryMapping`에 매핑 추가

### 2.4 skip 값 비대칭
- jhw-notion REPORT_VALUES: `none`만 정의 (skip 의도)
- redmine `reportSkipValues`: `none, private, note, no-report, skip` 5개 인식

→ 사용자가 Notion DB에 `private` select 옵션을 추가했을 때:
- jhw-notion `jhw_record`는 zod enum 거부 (입력 불가)
- redmine은 skip 처리

→ **권장**: `private`/`note` 등을 활용하려면 jhw-notion `REPORT_VALUES`에도 추가 후 두 프로젝트 동기화.

## 3. 동기화 체크리스트

새 select 옵션 / DB 추가 시:

- [ ] **DB 추가**:
  - [ ] jhw-notion `mcp-server/src/config.ts` `NOTION_CONFIG.databases` 추가
  - [ ] jhw-notion `mcp-server/src/schema.ts` `DATABASE_SCHEMAS`에 schema 추가
  - [ ] redmine `lib/collect-notion-api.js` `DATABASES` 추가 + `collectNotionItems`에 query 루프 추가
- [ ] **report select 옵션 추가**:
  - [ ] jhw-notion `config.ts` `REPORT_VALUES`에 추가
  - [ ] redmine `repo-config.json` `sources.notion.reportCategoryMapping`에 매핑 추가 (또는 `reportSkipValues`)
  - [ ] jhw-notion sandbox DB schema도 업데이트 (live test용)
- [ ] **project 필드 타입 변경**:
  - [ ] jhw-notion `mcp-server/src/notion/resolve-project.ts` 갱신
  - [ ] jhw-notion P0-1 회귀 테스트 검증
  - [ ] redmine `resolveProjectText`도 동일 패턴 따라가는지 확인
- [ ] **신규 프로젝트 키워드** (특정 도메인 추가):
  - [ ] redmine `repo-config.json` `sources.notion.searchKeywords`에 추가
  - [ ] redmine `sources.notion.projectMapping`에 키워드→카테고리 추가

## 4. 향후 작업 (P3+)

- **풀 MCP 통합**: redmine을 npm 프로젝트로 변환 후 `@modelcontextprotocol/sdk`로 jhw-notion `jhw_report_preview` 호출 (단일 source of truth, B 옵션)
- **schema-driven query**: redmine `collect-notion-api.js`에서 `DATABASES`를 jhw-notion `schema.ts` JSON 미러로 자동 빌드 (사람 동기화 부담 0)

## 5. 변경 이력

| 날짜 | commit | 내용 |
|---|---|---|
| 2026-04-30 | `c7ca7f7` | P0: project relation 처리 (resolveProjectText) |
| 2026-04-30 | `9646839` | P1: searchKeywords / excludePatterns config 외부화 |
| 2026-04-30 | (이번) | P2-A: reportCategoryMapping / reportSkipValues config 외부화 + 본 docs |
