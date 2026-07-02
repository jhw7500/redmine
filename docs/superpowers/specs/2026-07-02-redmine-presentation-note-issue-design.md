# 발표노트 → Redmine 작업(Issue) 자동 등록 설계

- 작성일: 2026-07-02
- 상태: 설계 승인 대기(사용자 리뷰)
- 대상 저장소: `/home/jhw/ai/opencode/projects/redmine`
- 관련 파이프라인: 주간 보고 cron(`run-generate-env.sh` generate→update, 매주 수 06:15)

## 1. 배경 / 문제

주간 보고서(Redmine **Wiki**: `advance-development-team/wiki/{날짜}_선행개발팀_주간_회의`)에는 Notion 5개 DB에서 `report` 분류값으로 모은 항목이 **제목(+임팩트)** 한 줄씩만 들어간다(본문·URL 없음, AI 축약). 그래서 regulatory.db 같은 **상세 기술노트**를 팀이 볼 방법이 없다.

- Notion 원본 링크는 부적합 — 개인 워크스페이스라 팀원 접근 불가(403).
- Redmine **Documents** 모듈은 REST 생성 불가(온인스턴스 실측: GET/POST 모두 403 = `accept_api_auth` 미개방). 자동화 불가.
- Redmine **Wiki**(200)와 **작업(Issues)**(200)은 REST 완전 지원. 사용자 결정: **작업(Issue)으로 등록**.
  - 이유: 이슈는 POST 생성 시 새 id를 응답으로 돌려줘 그 자리에서 링크 가능(Documents는 이게 불가라 막힘). 활동(Activity) 피드에 자동 노출되며 팀원이 Redmine 계정으로 접근.

## 2. 목표 / 비목표

**목표**
- Notion KB에 `발표노트` 태그가 붙은 항목을, 주간 보고 기간 안에 생성된 것에 한해, Redmine `advance-development-team` 프로젝트의 **작업(Issue)**으로 자동 등록한다.
- 이슈 본문에 Notion 페이지 **전체 본문(Markdown)**을 담는다.
- 주간 보고 Wiki의 조현우 섹션 하단에 **"📎 발표노트(상세)" 블록**으로 `#이슈번호` 목록을 넣어 연결한다.
- 재실행/기간 겹침에도 **중복 이슈가 생기지 않는다.**

**비목표**
- Documents 모듈 연동(불가로 확정).
- 기존 항목의 이슈 소급 생성(태그 붙은 신규분부터).
- Notion 본문의 100% 완벽 렌더(이미지/임베드 등 복합 블록은 best-effort, 텍스트/구조 우선).

## 3. 확정 요구사항

| # | 항목 | 결정 |
|---|---|---|
| 1 | 범위 | 파일럿(regulatory.db 1건 수동) → 검증 → cron 자동화 |
| 2 | 이슈화 표식 | KB `tags`(multi_select)에 **`발표노트`** 포함 |
| 3 | 중복방지 | 날짜 기간으로 선택 + **마커 가드**(이슈 본문 `Notion-Page-Id: <id>`) |
| 4 | 트래커/상태/담당자 | `검토`(id 9) / `검토`(id 7) / 본인(hwjo, id 36) |
| 5 | 본문 | Notion blocks → **Markdown 전체** |
| 6 | 링크 | 조현우 섹션 하단 "📎 발표노트(상세)" 블록에 `#id` (AI 축약 이후 결정적 삽입) |

## 4. 아키텍처 (선정: 전용 모듈, 기존 경로 비침습)

기존 collector/merger/AI 축약 경로를 건드리지 않고 **독립 모듈**을 추가한다.

### 4.1 신규 컴포넌트

**A. `lib/notion-blocks-to-md.js`** — Notion 블록 → Markdown 직렬화(children 재귀).
- 지원 블록: `heading_1|2|3`, `paragraph`, `bulleted_list_item`, `numbered_list_item`, `code`(언어 포함 ```펜스), `quote`, `divider`, `table`+`table_row`.
- 인라인(rich_text) 주석: bold(`**`), italic(`*`), code(`` ` ``), link(`[text](url)`).
- 미지원 블록: 플레인 텍스트로 폴백 + `<!-- unsupported: {type} -->` 주석(유실 가시화).
- 입력: `apiKey`, `pageId`. 출력: markdown 문자열. 페이지네이션(`has_more`/`next_cursor`)·중첩 children 처리.

**B. `lib/notion-issue-publisher.js`** — 핵심 오케스트레이션.
- `resolveMeta(config)` — `/trackers`,`/issue_statuses`,`/users/current`,`/projects/advance-development-team.json` 조회로 tracker/status/assignee id + **프로젝트 수치 id** 확정(이름 매칭). 1회 캐시. (하드코딩 대신 이름 기반 resolve → 인스턴스 변경에 견고. `POST /issues.json`의 `project_id`는 수치 id 필요.)
- `findPresentationNotes(apiKey, start, end)` — KB DB(`ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461`) query: `created_time ∈ [start,end]` **AND** `tags`(multi_select) contains `발표노트`. 반환: `[{pageId, title, notionUrl, createdDate}]`.
- `fetchPageMarkdown(apiKey, pageId)` — 컴포넌트 A 사용.
- `findExistingIssue(cfg, pageId)` — `GET /projects/{P}/issues.json?status_id=*&limit=100`(+필요시 offset 페이지네이션) 후 각 이슈 `description`에서 `Notion-Page-Id: <pageId>` 문자열 탐색. 있으면 그 이슈 반환(중복가드). 정확 조회 위해 이슈 상세가 필요하면 `?include=` 없이 description 포함 응답 사용.
- `createIssue(cfg, meta, note, md)` — `POST /issues.json`:
  - `project_id`: advance-development-team(수치 id는 resolveMeta에서 확정)
  - `tracker_id`: 9, `status_id`: 7, `assigned_to_id`: 36
  - `subject`: `[{reportLabel}] {KB제목}` (reportLabel 예: `WLAN-BSP`)
  - `description`: §4.2 구조
  - 반환: `{id, title, notionUrl}`
- `publishNotes(cfg, start, end, {dryRun})` — 상기 조합. 각 노트: 중복조회→있으면 재사용, 없으면 생성. `dryRun`이면 생성 대신 미리보기 출력. 반환: `[{id, title, notionUrl, reused}]`.

### 4.2 이슈 본문(description) 구조

```
{Notion 본문 Markdown 전체}

---
> 📎 출처: Notion KB — {notionUrl}
> Notion-Page-Id: {pageId}          ← 중복가드 마커(기계 판독)
> 자동 생성: redmine weekly ({생성일})
```

> Redmine 이슈 description은 대용량 텍스트(제한 사실상 없음) → Notion 2000자 절단 문제 없음. 전체 본문 수용.

### 4.3 파이프라인 통합 (Phase 2)

```
index.js (MODE=update, depth3 경로에서만)
  1) refs = publishNotes(cfg, periodStart, periodEnd)   // 이슈 생성/재사용
  2) publisher가 조현우 섹션 렌더 + AI 축약 완료 후,
     refs 있으면 섹션 말미에 블록 삽입:
        **📎 발표노트(상세)**
        - {title} — #{id}
  3) wiki PUT
```
- 이슈 생성은 **실제 발행하는 depth-3 `update`에서만** 호출(06:30 depth-2/generate 제외) → 동일 실행 1회.
- 삽입 위치: `publisher.js`의 조현우 섹션 조립 지점(AI 축약 결과 문자열에 append) — 기존 `replaceSection`/버전 409 재시도 흐름 유지.

## 5. 데이터 흐름 요약

```
KB(발표노트 태그, 기간내)
  └─ findPresentationNotes ─▶ [notes]
        └─ 각 note: findExistingIssue(마커)
              ├─ 있음 → reuse(id)
              └─ 없음 → fetchPageMarkdown → createIssue → id
  └─ refs[] ─▶ publisher: "📎 발표노트(상세)" 블록(#id) ─▶ Wiki PUT
```

## 6. 에러 처리

- 이슈 생성 실패(422/5xx): 해당 노트 **skip + 경고 로그**, 나머지 노트·주간보고 전체는 계속(부분 실패가 전체를 막지 않음).
- 중복조회(`findExistingIssue`) 실패(네트워크/5xx): **그 노트 skip**(생성 안 함) → 다음 주 재시도. 조회 불확실 시 "생성"보다 "건너뜀"을 택해 중복을 원천 방지.
- `resolveMeta` 실패: 전체 발표노트 단계 skip + 경고(주간보고 본문은 정상 발행).
- blocks 변환 부분 실패: 해당 블록만 폴백 주석, 이슈 생성은 진행.
- 마커 문자열은 정규화된 소문자/트림 없이 **원문 pageId(하이픈 포함 36자)** 그대로 비교.

## 7. 테스트

- **단위** `notion-blocks-to-md`: 블록 타입별 fixture(heading/list/code/table/quote/inline annotations) → 기대 Markdown. 미지원 타입 폴백 주석 확인.
- **단위** `findExistingIssue`: description에 마커 있는/없는 이슈 목록 mock → reuse/create 분기.
- **단위** `subject`/`description` 조립: reportLabel·마커·역링크 포함 확인.
- **파일럿(수동)**: `node lib/notion-issue-publisher.js --page 3908a230-a04e-81aa-a38b-c52b189d6785`
  - 결과: 이슈 1건 생성 → Redmine에서 본문 렌더/마커/담당자/트래커 육안 확인.
  - **재실행 시 skip(reuse)** 확인(중복가드 실증).
  - `--dry-run`으로 생성 전 미리보기 확인.

## 8. 단계(Phase)

- **Phase 1 (파일럿)**: 컴포넌트 A + B(`--page`, `--dry-run` CLI) 구현. cron 미변경. regulatory.db로 실증.
- **Phase 2 (자동화)**: `index.js`(update/depth3)·`publisher.js` "📎 발표노트(상세)" 블록 통합 + 단위테스트. cron 그대로(스케줄 변경 없음).

## 9. 미해결/후속

- reportLabel 규칙(확정): KB `report` 원문을 **대문자화**한다 — `wlan-bsp`→`WLAN-BSP`, `wlan-app`→`WLAN-APP`. (repo-config category 라벨과의 정합은 불필요; subject 접두는 단순·결정적이 우선.)
- 발표노트가 여러 개인 주: "📎 블록"에 모두 나열(상한 없음, 실제 수 적음).
- 이슈 category(Redmine) 지정은 생략(프로젝트에 이슈 카테고리 미설정).
