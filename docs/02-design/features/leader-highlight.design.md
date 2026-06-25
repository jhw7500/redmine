# leader-highlight.design.md — 팀장 회의 보고용 중요 항목 밑줄 강조

> 작성: 2026-06-25 | 상태: 승인됨 (접근 방식 A — AI 요약 프롬프트 조건부 주입)
> 배경: 주간보고 중 팀장이 **팀장 회의에서 별도로 보고할 중요 항목**을 표시하고 싶다.
> 목표: AI 요약 시 성과·이슈 중 보고 가치가 높은 항목을 밑줄(`<u>`)로 강조. 기능은 옵션(디폴트 off).

## 1. 요구사항 (사용자 확정)

| 항목 | 결정 |
|------|------|
| 강조 대상 판단 | **AI 자동 판단** (성과 + 이슈 둘 다) |
| 표시 형태 | `<u>...</u>` — 밑줄만 |
| 강조 위치 | 항목 대표 **한 줄**(상위 테마 줄/단일 핵심 줄), 같은 그룹 하위 중복 금지 |
| 기능 토글 | 옵션(코드 디폴트 off). **운영 기본 적용: `enabled: true`** (2026-06-25) |
| 개수 상한 | **옵션, 디폴트 무제한** (`maxLines: 0`) |
| 상한 적용 | AI 프롬프트 지시 (기존 `maxItemsPerSubcategory`와 동일, 코드 hard 강제 아님) |
| 설정 방법 | `repo-config.json` `reportFilter.leaderHighlight` + env override |

## 2. 아키텍처 (접근 방식 A: 프롬프트 조건부 주입)

강조는 **AI 요약 프롬프트에만** 작용한다. 수집·템플릿·Redmine 게시 흐름은 변경하지 않는다.
`buildDepthGuidance`와 동일한 "옵션 off면 빈 문자열 = 프롬프트 불변" 패턴을 따른다.

```
repo-config.json ──┐
  reportFilter.leaderHighlight      lib/config.js
   { enabled, maxLines, guidance }  env override (LEADER_HIGHLIGHT/_MAX 우선)
                                    reportFilter.leaderHighlight 노출
                                          │
                                          ▼
                                    lib/publisher.js
                                    buildLeaderHighlightGuidance(config)
                                          │ (enabled=false → "" = 프롬프트 불변, AI 밑줄 안 함)
                                          ▼
                                    buildFilterGuidance() 끝에 블록 추가
                                          ▼
                                    aiSummarize() 프롬프트에 「밑줄 — 최우선 출력 규칙」 주입
```

### 트레이드오프 (대안 비교)
- **B. 2차 AI 패스**: 요약과 밑줄 판단 분리. 관심사는 깔끔하나 AI 호출 2배·복잡도↑ — 기각.
- **C. config 블록 완전 분리**: 12개 `aiGuidance` 규칙이 이미 `buildFilterGuidance` 한 함수에 모여 있어 분리 실익 적음 — 헬퍼만 분리하고 호출은 `buildFilterGuidance` 내부에서.
- **상한 hard 강제(후처리 `<u>` 절단)**: LLM이 상한을 안 지키면 후속 추가. 기존 `maxItems`와 동일하게 soft(프롬프트)로 출발.

## 3. 컴포넌트별 변경

### 3.1 repo-config.json
- `reportFilter`에 `leaderHighlight` 추가. 코드 디폴트(키 미설정 시)는 off, **운영 적용값은 `{ "enabled": true, "maxLines": 0, "guidance": "" }`** (2026-06-25 기본 적용).
- `guidance` 비우면 publisher.js 내장 기본 규칙 사용. 채우면 본문 규칙만 대체(상한 문구는 항상 코드 생성).

### 3.2 lib/config.js
- `reportFilter.leaderHighlight` 로드. 우선순위: **env > repo-config > 디폴트**.
  - `enabled`: `LEADER_HIGHLIGHT`(=1 true / 그 외 false) → `leaderHighlight.enabled === true` → false.
  - `maxLines`: `LEADER_HIGHLIGHT_MAX`(정수) → `leaderHighlight.maxLines` → 0(무제한). `Math.max(0, …)`로 음수/비정상은 0으로 정규화.

### 3.3 lib/publisher.js
- `buildLeaderHighlightGuidance(config)` 신설:
  - `enabled=false`면 `""` 반환 → 프롬프트 불변, AI 밑줄 안 함.
  - `enabled=true`면 「팀장 회의 보고용 중요 항목 표시 (밑줄) — 최우선 출력 규칙」 블록 반환.
  - `maxLines>0`이면 "최대 N줄" 상한 문구, `0`이면 "상한 없음 + 절제" 문구.
- `buildFilterGuidance()` 끝에 `${highlightBlock}` 추가 (off면 빈 문자열이라 무영향).
- exports에 `buildFilterGuidance`, `buildLeaderHighlightGuidance` 추가(테스트용).

### 3.4 README.md
- Optional env vars에 `LEADER_HIGHLIGHT`, `LEADER_HIGHLIGHT_MAX` 추가.

## 4. 에러 처리 / 호환
- **옵션 미설정**(repo-config에 `leaderHighlight` 키 없음): `enabled=false, maxLines=0` → 기존 동작과 바이트 동일(회귀 없음).
- **AI 요약 실패(null)**: `aiSummarize`가 null → `rawSection` 폴백 → 밑줄 없는 원본.
- **구조 검증 게이트**(파란 헤더/`sectionHeader` 카운트), `stripAstralChars`: `<u>`와 무관 → 영향 없음.
- **발행(update)**: generate가 만든 초안 파일을 그대로 PUT → 밑줄도 사람이 검토·수정 가능(기존 워크플로우 일관).

## 5. 테스트 계획 / 결과
1. 정적: `node --check` (config.js / publisher.js), repo-config.json JSON 파싱 — **통과**.
2. config 단위: env 미설정/=1/=0 × `MAX` 미설정/=3 → `leaderHighlight` 기대값 — **통과**.
3. 프롬프트 회귀: `enabled=false`에서 `buildLeaderHighlightGuidance()===""` + `buildFilterGuidance`에 섹션 없음 — **통과**.
4. 주입 확인: `enabled=true`에서 `<u>`·상한 문구·섹션 헤더 포함 — **통과**.
5. E2E(선택): `LEADER_HIGHLIGHT=1 MODE=generate` 실제 실행 → `out/*.md`에서 `<u>` 위치 육안 확인(위키 PUT 없이). claude CLI 호출 필요 — 미실행.

## 6. 범위 외 (YAGNI)
- 상한 hard 강제(후처리 `<u>` 절단) — 필요 확인 시 후속.
- 밑줄 외 강조(볼드/색) — 사용자가 "밑줄만" 확정.
- 사람·섹션별 개별 토글 — 현재 조현우 섹션 단일이라 불필요.
