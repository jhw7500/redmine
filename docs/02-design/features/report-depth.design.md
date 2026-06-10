# report-depth.design.md — 보고서 상세도(depth) 단계 설정

> 작성: 2026-06-10 | 상태: 승인됨 (접근 방식 A — 프롬프트 프로파일)
> 배경: 현재 보고서가 bullet 최대 4단 중첩 + 괄호 부연 과다로 너무 디테일함.
> 목표: 뎁스를 1/2/3 단계로 지정해 단계별로 생성·비교 테스트할 수 있게 한다.

## 1. 요구사항 (사용자 확정)

| 항목 | 결정 |
|------|------|
| 뎁스 의미 | 들여쓰기 깊이 + 문장 상세도를 묶은 **프리셋** |
| 단계 수 | **3단계** — 1=요약, 2=표준, 3=상세(현재 동작) |
| 기본값 | **2 (표준)** — 지금보다 한 단계 간결 |
| 설정 방법 | `repo-config.json` `defaults.reportDepth` + `REPORT_DEPTH` env override |
| 테스트 | 비교 스크립트 — 1회 수집으로 depth 1/2/3 출력을 나란히 생성 |

## 2. 아키텍처 (접근 방식 A: 프롬프트 프로파일)

뎁스는 **AI 요약 프롬프트에만** 작용한다. 수집(merger 입력 cap)·템플릿·Redmine 게시 흐름은 변경하지 않는다.

```
repo-config.json ──┐
  defaults.reportDepth=2          lib/config.js
  depthProfiles{1,2,3}  ──────▶   env.reportDepth (REPORT_DEPTH 우선, 1~3 검증)
                                  depthProfiles 노출
                                        │
                                        ▼
                                  lib/publisher.js
                                  buildDepthGuidance(config)
                                        │ (depth=3 → 빈 문자열 = 프롬프트 불변)
                                        ▼
                                  aiSummarize() 프롬프트에 「상세도 규칙 — 최우선」 블록 주입
```

### 트레이드오프 (대안 비교)
- **B. 후처리 강제**: 깊이 100% 보장하지만 기계적 절단으로 정보 손실 + 복잡도 증가. 테스트에서 LLM이 깊이를 안 지키는 게 확인되면 그때 추가.
- **C. 단계별 프롬프트 파일 분리**: 13개 aiGuidance 규칙 3벌 중복 — drift 위험으로 기각.

## 3. 컴포넌트별 변경

### 3.1 repo-config.json
- `defaults.reportDepth: 2` 추가.
- 최상위 `depthProfiles` 섹션 추가:
  - `"1"` (요약): 들여쓰기 최대 2단(카테고리 > 항목), 서브카테고리 헤더 생략, 카테고리당 최대 5줄, 괄호 부연 금지, 버그 검출도 1줄 요약.
  - `"2"` (표준): 들여쓰기 최대 3단(카테고리 > 서브카테고리 > 항목), 4단 세부 bullet 금지(필요 세부는 괄호 1개로 흡수), 서브카테고리당 최대 3줄, 괄호 부연 줄당 1개·짧게, 버그 검출은 증상/원인/결과 각 1줄 유지.
  - `"3"` (상세): `promptGuidance: ""` — 현재 프롬프트와 동일 (회귀 없음).
- 프로파일 스키마: `{ "label": string, "promptGuidance": string }`.

### 3.2 lib/config.js
- `env.reportDepth` 결정: `REPORT_DEPTH` env → `defaults.reportDepth` → `2`.
- 검증: 1~3 정수가 아니면 경고 출력 후 2로 폴백 (실행은 계속 — cron 안정성).
- `depthProfiles: raw.depthProfiles || {}` 를 config에 노출.

### 3.3 lib/publisher.js
- `buildDepthGuidance(config)` 신설:
  - 현재 depth의 프로파일 `promptGuidance`가 비어있지 않으면
    `## 상세도(depth=N: label) 규칙 — 최우선\n(다른 규칙과 충돌하면 이 섹션이 우선한다)\n<guidance>` 반환, 아니면 `""`.
- `aiSummarize()`: 「핵심 원칙」 섹션 직후·filterGuidance 앞에 조건부 삽입.
  **depth=3이면 빈 문자열이라 프롬프트가 기존과 바이트 동일** — 기존 동작 회귀 없음.
- 로그: `AI 요약 중... (depth=N label)`.
- exports에 `buildContent`, `aiSummarize`, `buildOutputPath` 추가 (depth-test 재사용용).

### 3.4 scripts/depth-test.js (신규)
- index.js와 동일하게 회의 날짜 결정 → **수집 1회** (notion/session/git) → `buildContent()`로 rawSection 1회 구성.
- depth 1→2→3 순차로 `aiSummarize()` 호출 (config 객체를 depth만 바꿔 얕은 복사).
- 출력: `out/jo-hyunwoo-YYYY-MM-DD.depth1.md` / `.depth2.md` / `.depth3.md` — 원본 보고서(`jo-hyunwoo-YYYY-MM-DD.md`)는 건드리지 않음.
- 실패한 depth는 경고 후 스킵, 마지막에 단계별 성공/실패 + 줄 수 요약표 출력. 1개 이상 실패 시 exit 1.

### 3.5 run-depth-test.sh (신규, 루트)
- `run-generate-env.sh`와 동일한 `.env` + `NOTION_API_KEY`(bashrc) 로딩 패턴.
- `AI_SUMMARIZE=1` 강제 후 `node scripts/depth-test.js` 실행. 실행 권한(+x) 부여.

### 3.6 README.md
- Optional env vars에 `REPORT_DEPTH` (1=요약, 2=표준(기본), 3=상세) 추가.
- Run 섹션에 `./run-depth-test.sh` 사용법 1줄 추가.

## 4. 에러 처리
- `REPORT_DEPTH` 비정상 값(0, 4, abc): 경고 + 2로 폴백, 종료하지 않음.
- `depthProfiles`에 해당 depth 키 없음/`promptGuidance` 없음: 빈 가이드 = depth 3 동작 (안전한 기본).
- depth-test에서 AI 호출 실패(null): 해당 depth 스킵·요약표에 FAIL 표기, raw를 depth 파일로 저장하지 않음 (혼동 방지).

## 5. 테스트 계획
1. **정적**: `node --check` (config.js / publisher.js / depth-test.js).
2. **config 단위**: `REPORT_DEPTH=1|2|3|0|abc|미설정` × `loadConfig()` → reportDepth 기대값 (1/2/3/2+경고/2+경고/2).
3. **프롬프트 회귀**: depth=3에서 `buildDepthGuidance() === ""` 확인 → 프롬프트 불변 보장.
4. **E2E**: `./run-depth-test.sh` 실제 실행 → 3개 출력 파일 생성·깊이/줄수 비교 (claude CLI 호출, 회당 수 분).

## 6. 범위 외 (YAGNI)
- 후처리 깊이 강제(접근 B) — 테스트에서 필요 확인 시 후속.
- merger 입력 cap(`maxItemsPerSubcategory`)의 depth 연동 — 입력 데이터는 모든 depth에서 동일해야 비교 테스트가 성립하므로 의도적으로 제외.
- update(게시) 모드 전용 depth — generate/update 모두 `env.reportDepth`를 그대로 따른다.
