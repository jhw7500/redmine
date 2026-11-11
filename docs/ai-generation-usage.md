# 주간보고 AI 생성 사용 가이드

이 문서는 `MODE=generate`에서 사용할 AI 실행기(provider), 모델, 보고서 상세도와 생성 범위를 설정하는 방법을 설명한다. `generate`는 sealed snapshot을 읽어 로컬 보고서와 검증 산출물만 만들며 Redmine에는 쓰지 않는다. 실제 게시에는 별도의 `MODE=update` 실행이 필요하다.

## 기본 운영값

환경변수를 지정하지 않으면 다음 조합을 사용한다.

```text
AI_PROVIDER=claude
AI_MODEL=sonnet
AI_EFFORT=low
AI_GENERATION_SCOPE=whole
AI_GENERATION_METHOD=freeform
REPORT_DEPTH=2
AI_TIMEOUT_MS=300000
```

위 값은 코드 기본값이며 실제 cron의 환경변수와 다를 수 있다. 2026-09-09 장애 실행은 `Codex gpt-5.6-sol + whole`이었다. 이 변경은 cron이나 `.env`를 수정하지 않는다.

## 판정어 검증

schema v2는 숫자가 없는 `PASS`·`FAIL`·`통과`·`실패`도 보호한다. 유지한 판정 진술은 원문의 테스트·명령, 조건·부정, 부모와 하위 문맥, fact ID 순서를 보존해야 한다. 허용된 버전 표기 정규화와 불릿 전체의 밑줄, 원천에 있는 `[Notion]` 출처 라벨의 생략은 가능하다. 독립된 진술 전체의 순서 변경과 레코드 전체 생략도 가능하지만 같은 근거를 중복 사용할 수 없다.

`PASSWORD`·`FAILURE` 같은 식별자, 정확한 `fail-closed` 용어와 `통과율`·`실패율` 명사는 판정으로 분류하지 않는다. 그 외 한국어 활용·부정은 의미를 추론하지 않고 원문 진술로 보존한다. 새 HTML 엔티티나 단어를 조립하는 Markdown 참조 링크는 렌더 결과를 추측해 허용하지 않으며 원문과 같은 진술에서만 허용한다. `source_selection`의 계층 재배치는 snapshot에서 재구성한 선택·렌더 전체가 일치할 때만 인정한다.

생성·재검증·게시 직전에 같은 사실 검증을 수행한다. 과거 catalog가 원문의 판정어를 보호하지 못하면 `verdict_catalog_mismatch`로 차단하므로 새 run을 생성해야 한다. 문맥 변경은 `verdict_context_mismatch`, 판정 근거 중복은 `duplicate_verdict_claim`이며 `VALIDATION_OVERRIDE=1`로도 우회할 수 없다. 중립 릴리즈 버전은 상태와 독립적으로 선택할 수 있고, 별도로 표시한 릴리즈 설치 실패는 기존 단계·버전 근거에 결속한다.

이 검증은 남아 있는 근거 ID와 원문 진술을 대조한다. 모든 근거 ID를 제거한 자연어 재서술의 의미까지 추적하지는 않는다. 생성 품질 검증이 요구하는 형식과 판정 진술 보존을 함께 만족할 수 없으면 해당 항목을 통째로 제외하거나 검증 실패로 남긴다.

## 설정 우선순위

AI 설정은 환경변수가 `repo-config.json`의 `defaults`보다 우선한다.

| 환경변수 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `AI_SUMMARIZE` | `0` 또는 `1` | `0` | `1`일 때만 AI 요약과 schema v2 검증을 실행한다. |
| `AI_PROVIDER` | `claude`, `codex` | `claude` | 사용할 CLI 실행기다. 잘못된 값은 호출 전에 차단된다. |
| `AI_MODEL` | provider가 지원하는 모델명 | Claude `sonnet`, Codex `gpt-5.6-sol` | 환경변수로 지정하면 provider별 기본 모델보다 우선한다. |
| `AI_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` | `low` | CLI에 전달하는 reasoning effort다. |
| `AI_GENERATION_SCOPE` | `whole`, `project` | `whole` | 전체 1회 생성 또는 최상위 프로젝트별 순차 생성을 선택한다. |
| `AI_GENERATION_METHOD` | `freeform`, `source_selection` | `freeform` | 문장 재작성 또는 원문 ID 선택 후 코드 렌더링. 잘못된 값은 호출 전에 차단한다. |
| `SOURCE_SELECTION_FALLBACK` | `0`, `1` | `1` | `source_selection`에서만 실행/JSON 선택 실패 시 원문 대체본을 만든다. 검증 실패는 우회하지 않는다. |
| `REPORT_DEPTH` | `1`, `2`, `3`, `4` | `2` | 1=요약, 2=표준, 3=중간, 4=상세다. |
| `AI_MAX_INPUT_CHARS` | 양의 정수 | `100000` | 호출별 전체 prompt 문자 수 상한이다. 초과하면 CLI를 실행하지 않는다. |
| `AI_TIMEOUT_MS` | 양의 정수 | `300000` | AI 단일 호출 timeout이다. `project` 전체가 아니라 각 파트에 적용된다. |
| `AI_MAX_BUDGET_USD` | 양수 | 미설정 | Claude CLI에만 `--max-budget-usd`로 전달한다. |
| `CLAUDE_CLI` | 실행 파일 경로/이름 | `claude` | Claude CLI를 바꿀 때 사용한다. |
| `CODEX_CLI` | 실행 파일 경로/이름 | `codex` | Codex CLI를 바꿀 때 사용한다. |

`AI_PROVIDER=codex`이고 `AI_MODEL`이 없으면 `repo-config.json`의 `codexModel`을 사용한다. Claude를 선택하면 `aiModel`을 사용한다. provider 변경 시 다른 provider로 자동 fallback하지 않으며, 실패한 호출도 자동 재시도하지 않는다.

## Provider와 모델 선택

### Claude Sonnet

코드 기본 provider다. 모델 변경만으로 사실·대상 검증의 구조적 실패가 해결되지는 않는다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=claude AI_MODEL=sonnet \
AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

### Claude Opus

품질 비교가 필요할 때 명시적으로 선택한다. 모델을 올려도 사실-대상 검증 통과가 보장되지는 않는다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=claude AI_MODEL=opus \
AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

### Codex

명시적으로 선택하는 provider이며 2026-09-09 cron 실행에서도 사용되었다. `gpt-5.6-sol` 이외의 모델을 시험할 때는 `AI_MODEL`을 함께 지정한다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=codex AI_MODEL=gpt-5.6-sol \
AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

Claude는 safe mode, 빈 tools, session persistence 비활성 상태로 실행한다. Codex는 격리된 임시 디렉터리, ephemeral mode와 read-only sandbox에서 실행한다. 두 실행기 모두 프로젝트 plugin·hook·MCP와 사용자 전역 model/effort를 보고서 호출에 상속하지 않는다.

## 전체 생성과 프로젝트별 분할

### `whole`

- 조현우 섹션 전체를 한 prompt로 전달한다.
- AI 호출은 1회다.
- 평소 작업량과 기본 cron에 권장한다.
- 생성 후 전체 schema v2 사실·source coverage 검증을 수행한다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

### `project`

- 내용이 있는 최상위 프로젝트를 `PIM` → `Wireless Lan` → `ETC` 순서로 호출한다.
- 최대 3회이며, 입력에 없는 최상위 프로젝트는 호출하지 않는다.
- 각 파트 직후 사실·source 검증을 수행한다.
- 한 파트가 차단되면 뒤 파트는 호출하지 않는다.
- 통과한 파트만 설정 순서로 병합하고, 병합 결과에 전체 schema v2 검증을 다시 수행한다.
- 큰 입력을 위한 파일럿 옵션이며, 현재 기본 cron에는 사용하지 않는다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=claude AI_MODEL=sonnet \
AI_GENERATION_SCOPE=project REPORT_DEPTH=3 \
AI_EFFORT=medium AI_TIMEOUT_MS=900000 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

Codex 분할을 시험할 때는 provider와 모델만 바꾼다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=codex AI_MODEL=gpt-5.6-sol \
AI_GENERATION_SCOPE=project REPORT_DEPTH=3 \
AI_EFFORT=medium AI_TIMEOUT_MS=900000 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

## 권장 조합

| 상황 | Provider/model | Scope | Depth | 비고 |
|---|---|---|---:|---|
| 코드 기본값 기반 실행 | Claude Sonnet | `whole` | 3 | 실제 cron 설정과는 별개 |
| 평소보다 입력이 큰 주 | Claude Sonnet | `project` | 3 | 파일럿으로 실행하고 파트 검증 결과를 확인 |
| 간결성 A/B 비교 | Codex `gpt-5.6-sol` | `whole` | 3 | 한 주 표본에서는 가장 간결했지만 기본값은 아님 |
| 모델 상향 비교 | Claude Opus | `whole` | 3 | 비용·시간 증가가 검증 통과를 보장하지 않음 |

`project`가 실패했다고 검증 기준을 완화하거나 자동으로 `whole`을 재호출하지 않는다. 같은 sealed snapshot으로 설정을 명시해 새 generate를 실행한다.

## 원문 선택 방식 — 재발 방지 파일럿

`AI_GENERATION_METHOD=source_selection`은 AI에 문장을 쓰게 하지 않는다. sealed snapshot의 항목 ID·순서·고정 테마·강조 여부만 받는다. 코드는 선택된 원문 문장, 부모 조건(일반 문장 포함), 카테고리를 보존해 Markdown을 만든다. 원문 자체의 오류까지 교정하거나 요약 품질을 보장하지는 않는다.

```text
sealed snapshot -> source records -> one AI selection -> code renderer -> validation
                                            |
                                     selection failure
                                            |
                                     labelled fallback -> validation
```

다음은 로컬 생성 예시다. `SNAPSHOT_PATH`는 기존 sealed snapshot의 절대 경로로 지정하고 `OUTPUT_DIR`는 별도 비교 디렉터리로 지정한다. `node index.js`는 `.env`를 자동 로드하거나 실패 알림을 전송하지 않는다.

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=codex AI_MODEL=gpt-5.6-sol \
AI_GENERATION_METHOD=source_selection AI_GENERATION_SCOPE=whole \
SOURCE_SELECTION_FALLBACK=1 REPORT_DEPTH=3 \
MEETING_DATE=2026-09-09 \
SNAPSHOT_PATH=/absolute/path/report-2026-09-09.snapshot.json \
OUTPUT_DIR=/absolute/path/source-selection-pilot node index.js
```

- 이 방식은 `AI_SUMMARIZE=1`, `whole`만 지원한다. AI 비활성 설정은 `AI_SELECTION_REQUIRES_AI`, `project`는 `AI_SELECTION_SCOPE`로 run 생성 전에 차단한다. 기존 `freeform` 기본값은 유지한다.
- 정상 AI 응답은 JSON만 허용한다. 존재하지 않는 ID, 다른 카테고리의 ID, 중복, 누락된 섹션, 추가 문장·필드는 거부한다.
- `LEADER_HIGHLIGHT`와 `LEADER_HIGHLIGHT_MAX`를 프롬프트 및 선택 검증에 적용한다. 강조가 꺼져 있거나 전체 선택의 강조 개수가 상한을 넘으면 잘못된 선택으로 처리한다. 상한 `0`은 기존 설정대로 무제한이다. 재검증·게시에서도 현재 강조 정책을 다시 검사한다.
- 강조 대상 분야와 중요도는 `reportFilter.leaderHighlight.guidance`를 따른다. 안내가 비어 있으면 특정 분야로 제한하지 않고 주요 성과·이슈를 기본 기준으로 사용한다.
- fallback은 실행 실패·timeout·quota·잘못된 선택 JSON에만 적용한다. AI 재호출 없이 depth별 최소 목표(depth 1/2/3/4: 8/16/24/32개)까지 canonical section을 순회하며 원문 순서대로 한 항목씩 배분하고 **원문 기반 대체 보고서**로 표시한다. 섹션당 최대 9개이며, 전체 목표는 섹션 수 이상으로 잡되 실제 선택 가능량으로 제한한다. 각 섹션의 선택 항목은 최대 3개씩 묶는다. 중요도 선별이나 같은 ETC 섹션 안의 프로젝트별 균형은 보장하지 않는다.
- 설정 오류, 입력 상한 초과, source-record 구성 실패, artifact 저장·소유권·검증 실패는 fallback 대상이 아니다. `SOURCE_SELECTION_FALLBACK=0`이면 선택 오류도 그대로 실패한다.
- 수집 결과가 채워진 필수 카테고리에 원문 항목이 없으면 `SOURCE_RECORDS_INVALID`로 차단한다. 이를 원문에 없는 “특이사항 없음”으로 바꾸지 않는다. 실제 변경이 없는 카테고리(`(변경 없음)`)는 기존 coverage 규칙에 따라 필수 섹션에서 제외한다.
- 원문에 없는 as-of 날짜나 완료 상태를 합성하지 않는다. 미해결·보류 등은 기존 git 제목 대조와 심볼 pickaxe 검사를 거치며, 근거 없는 상태는 날짜가 있어도 게시를 차단한다. 이 오류는 `VALIDATION_OVERRIDE`나 warn 설정으로 우회할 수 없다.
- 원문의 부모 조건 보존이 분량·depth보다 우선한다. 같은 부모 아래 여러 항목을 고르면 부모가 반복될 수 있다.
- 목록 앞·사이·뒤의 부모 문단은 들여쓰기와 빈 줄 경계로 소유자를 판별해 모든 선택된 자손에 보존한다. 소유자가 불명확한 내어쓰기 문단은 추측하지 않고 생성 전에 거부한다. 수집기가 만드는 고정 두 칸 들여쓰기 `↳` 부가 설명은 기존 계약대로 해당 커밋에만 붙인다.
- 원문 목록은 `-`·`*`·`+`를 지원한다. 일반 카테고리 바로 아래의 `개선` 등 기본 커밋 유형 헤딩만 조건 문단이 없을 때 중복 렌더링하지 않는다. ETC의 프로젝트명(`기타` 포함)과 더 깊은 의미 문맥은 보존한다. GLIBC·wpa_supplicant 버전은 `2.12-rc1`, `2.12b`, `2.12+build.7` 같은 접미사까지 하나의 사실로 보호한다.

새 run에는 `source-records.json`, `source-selection.json`이 추가된다. 선택 origin(`ai`/`deterministic_fallback`), 실패 코드, 응답 수신 여부, hash를 기록한다. `draft.ai.annotated.md`는 이 방식에서 Markdown이 아니라 **provider stdout 원문**이다. UTF-8 스트림 디코딩으로 여러 조각에 나뉜 문자를 보존한다. 부분 응답 후 실패해도 보존하고, 실행조차 못 했으면 빈 파일과 `aiResponseReceived:false`로 구분한다.

검증이 실패해도 사람이 읽을 수 있는 marker 제거본을 run 안의 `report.rejected.NNN.md`로 차수별 보존한다. 이 파일은 로컬 진단 전용이며 정식 `jo-hyunwoo-*.md` 경로로 승격되지 않는다. 전역 generation state와 run state도 계속 실패로 남기 때문에 `MODE=update`는 Redmine API 호출 전에 거부한다. 재검증이 다시 실패하면 기존 파일을 덮어쓰지 않고 다음 차수 파일을 추가한다.

재검증·게시 단계는 snapshot + 저장된 카탈로그로 원문 레코드와 보고서를 다시 만들어 동일성을 확인한다. `draft.working.annotated.md`를 임의로 고쳐 통과시키는 복구는 허용하지 않는다. 원본 근거를 바로잡아 새 snapshot/run을 생성하거나, 코드 오류를 수정한 뒤 기존 증거를 그대로 재검증한다. `freeform`의 기존 수동 복구 경로는 유지한다.

### AI 없이 과거 snapshot 재생

```bash
node scripts/replay-source-selection.js \
  --snapshot /absolute/path/report-2026-09-09.snapshot.json \
  --draft /absolute/path/runs/2026-09-09/RUN_ID/draft.working.annotated.md \
  --output-dir /absolute/path/new-replay-directory
```

`--draft`, `--output-dir`는 선택 사항이다. 비교 draft는 같은 snapshot을 사용한 v2 run의 확장된 annotated 파일이어야 하며, 옆의 state/fact/source 카탈로그로 원래 ID를 검증한다. 기존 카탈로그를 새 ID로 덮어쓰지 않는다. 출력 디렉터리는 이미 있으면 거부한다.

이 도구는 AI·Redmine·live git을 호출하지 않고 결정적 fallback을 평가한다. 게시 증거는 만들지 않는다. 상태 근거가 필요한 항목은 미검증으로 남는다. 종료값은 새 발췌본의 blocking 오류 없음=0(경고 가능), 검증 FAIL=2, 입력/실행 오류=1이다. 원본 draft의 FAIL은 비교 정보이며 종료값을 결정하지 않는다.

2026-09-09에 08-26/09-02/09-09 snapshot을 재생했다. 발췌본은 각각 17/17/15개 항목이며 blocking 오류는 모두 0건, 제외된 Notion 원문 marker 경고는 161/107/171건이었다. 오늘 기존 draft는 밑줄 오탐 수정 후에도 `fact_subject_mismatch` 9건이 남았다. 이는 선택·렌더링 및 fallback 경로의 오프라인 검증 결과이며 실제 AI 선택 품질이나 운영 전환 완료를 뜻하지 않는다.

## 안전한 실행 순서

### 1. Snapshot 수집

```bash
MODE=collect MEETING_DATE=2026-08-26 ./run-report-env.sh
```

### 2. AI 보고서 생성과 검증

```bash
MODE=generate AI_SUMMARIZE=1 \
AI_PROVIDER=claude AI_MODEL=sonnet \
AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 \
MEETING_DATE=2026-08-26 ./run-report-env.sh
```

### 3. 검증 결과 확인

canonical 보고서와 같은 이름의 `.generation.json`, `.validation.json`을 확인한다. schema v2 상세 증거는 `out/runs/<회의일>/<run-id>/`에 있다.

### 4. 검증된 결과만 별도 게시

```bash
MODE=update REPORT_DEPTH=3 MEETING_DATE=2026-08-26 ./run-report-env.sh
```

`update`는 AI를 호출하지 않는다. 동일 회의일·depth·snapshot hash의 `complete` 증거가 없으면 Redmine 요청 전에 중단한다.

## 산출물 확인

AI-enabled generate의 `prompt-input.json`에는 다음 실행 증거가 기록된다.

- `provider`, `model`, `effort`
- `generationScope`, `callCount`
- 전체 `promptHash`, `promptLength`, `timeoutMs`
- `project`일 때 파트별 `id`, `promptHash`, `promptLength`

주요 파일:

| 파일 | 용도 |
|---|---|
| `out/jo-hyunwoo-YYYY-MM-DD.depthN.md` | 전체 검증을 통과해 승격된 clean 보고서 |
| `out/runs/YYYY-MM-DD/<run-id>/prompt-input.json` | provider/model/scope와 prompt 결속 증거 |
| `out/runs/YYYY-MM-DD/<run-id>/draft.ai.annotated.md` | `whole` 또는 병합 완료된 `project`의 변경 금지 AI 원본 |
| `out/runs/YYYY-MM-DD/<run-id>/draft.ai.part.NNN.annotated.md` | `project` 파트별 변경 금지 AI 원본. 중간 실패 시에도 완료 파트까지 보존 |
| `out/runs/YYYY-MM-DD/<run-id>/draft.working.annotated.md` | 전체 생성 후 fact marker를 확장한 수동 복구 대상 |
| `out/runs/YYYY-MM-DD/<run-id>/validation.NNN.json` | 검증 이슈와 revision 증거 |
| `out/runs/YYYY-MM-DD/<run-id>/state.json` | run 상태와 `partFailure` 상세 |

`project`가 중간 파트에서 실패하면 병합 draft와 canonical 보고서는 생성되지 않는다. `draft.ai.part.NNN.annotated.md`와 `state.json`의 `partFailure`를 확인한다. 부분 출력은 `MODE=revalidate` 대상이 아니며, 원인 수정 또는 다른 명시적 설정으로 generate를 새로 실행한다.

## 주간 pair의 팀 독자용 요약

`repo-config.json`의 `reportFilter.teamReport.enabled=true`이면 pair의 회의용 summary만 팀 독자용으로 생성한다. 상세 depth2·depth3와 Slack 상세 근거는 기존 원문 선택 방식 유지.

- 원본 sealed snapshot은 유지하고 summary의 필수 source coverage를 프로젝트 루트(PIM·Wireless Lan·ETC)로 설정. 숫자·상태와 다른 프로젝트로의 근거 이동 검증은 유지.
- 원문을 자르지 않도록 기존 `project` scope를 사용. 존재하는 프로젝트마다 한 번 호출하며, 한 summary generation 안에서 실행한다. 실패한 summary를 자동 재생성하지 않음.
- `teamReport.guidance`에 프로젝트 중심 내용, 명사형 종결, 한 줄 한 항목, 내용별 들여쓰기, 웹 GPT·MCP 터널링과 빌드 서버의 분리 기준을 설정.
- 실제 릴리즈 버전과 측정·단축 시간, 용량·처리량·온도·전력 등 성과 수치는 보존. 커밋·중간 빌드 식별자만 제외하며, 값·단위·측정 대상·조건과 패키지 제작/장비 설치/고객 전달 단계를 함께 유지. 근거 없는 수치나 계산값은 추가하지 않음.
- `leaderHighlight.guidance`는 상세 선택과 summary에 공통 적용. ETC도 같은 중요도 기준으로 선정하며 대표 성과 한 줄에만 밑줄 표시.
- team summary 품질 검사에서 구현 경로·명시적인 식별자, 서술형 종결, 한 줄의 여러 문장, 강조 비활성/상한 위반을 차단. 원문 근거와 의미 보존은 최종 검토 대상.
- `publish auto`는 유효한 summary를 선택하고, summary가 실패하면 기존 depth2 fallback을 유지. 수동 수정본을 검증된 summary로 가장해 게시하지 않음.
- 설정 변경은 다음 cron 준비부터 적용. 기존 pair의 immutable 산출물을 재작성하지 않음. Redmine 게시와 Slack 전송에는 별도 승인 필요.
- 생성 당시 audience·밑줄 사용 여부·상한은 `summaryQualityProfile`로 run·generation·prompt-input 증거에 결속. 게시 시 해당 기준으로 재검사하며, 이 필드가 없는 과거 summary는 기존 작성 기준 적용.

새 팀 요약은 읽기 쉬운 원문 측정 구절을 `M` 근거로 묶는다. AI가 ID를 선택하면 코드가 대상·조건·변경 전후·단위가 고정된 구절을 독립 불릿으로 확장한다. `teamReport.termAliases`는 첫 수치 앞의 업무 용어만 바꾸며 숫자 이후의 값·단위·조건은 원문 그대로 유지한다. 실제 릴리즈 버전은 suffix까지 보존한 중립적인 버전 불릿으로 출력한다. 제작·장비 설치·고객 전달은 별도 원문 근거로 확인하고, 제작 버전과 설치 버전이 다르면 각각 표시한다.

릴리즈의 제작·설치·고객 전달 설명은 같은 원문 절에 해당 버전과 명시적인 단계·상태가 함께 확인된 근거에 결속한다. 새 catalog에는 원문 구절과 위치를 `releaseStageEvidence`로 보존하고 재현 검증한다. 서로 다른 버전이나 상태 변화가 한 절에 섞였거나 단계·상태가 불명확하면 완료 근거로 인정하지 않는다. 단계 설명은 ‘장비 설치 완료’처럼 한 줄에 상태까지 명시하고 바로 아래에 버전 불릿을 배치한다. 상위 단계 설명과 버전 근거가 다르면 `release_stage_mismatch`로 차단하며 override로 우회할 수 없다. 같은 부모 아래의 평면 배치는 바로 인접한 단계와 버전을 일대일로 연결할 수 있을 때만 허용한다. 멀리 떨어졌거나 양옆의 여러 버전 중 하나를 골라야 하는 단계 설명은 차단한다. 근거가 없는 버전은 중립적인 버전 표기만 사용할 수 있다.

부정 판정은 독립된 `미·비·불·안` 토큰 또는 단계어에 바로 붙은 접두 부정을 대상으로 한다. 문장 분할 전에 단어를 한 번 순회하며, 부정 토큰과 동작 사이의 공백·구두점·기호·서식 문자를 공통 구분자로 읽는다. `미-설치`, `미—패키지—제작`처럼 구분자나 대상어가 끼어도 완료 근거로 취득하지 않는다. 기존 단계 문법의 장비·보드·고객에 부정이 붙은 `장비미적용`, `보드미-배포`, `고객미전달`도 같은 규칙으로 차단한다. 긍정 문장과 원문 증거는 재작성하지 않고 `미디어·이미·도우미·국비` 같은 정상 단어는 부정 토큰으로 취급하지 않는다. `장비 안 케이블 설치 완료`처럼 장소와 부정 중 어느 뜻인지 판별할 수 없는 `안`도 완료 근거에서는 제외하므로, 이런 원문은 중립적인 버전 표기를 사용하거나 의미가 명확한 원문 근거를 따로 확보해야 한다.

단계 앞에도 상태가 있으면 뒤의 명시적인 상태와 같은 사전으로 대조한다. 예정·계획·미완료·미실행·실패·취소·철회·중단·보류를 앞뒤에서 공통으로 인식하며, 서로 일치하면 해당 상태를 유지한다. `미완료 패키지 제작 확인`, `완료 장비 설치 예정`처럼 상태가 충돌하거나 뒤의 상태가 불명확하면 단계 근거를 취득하지 않고 중립적인 버전 표기만 허용한다. 상태어 전체와 제한된 연결어·대상어가 일치할 때만 수집하므로 `계획서·취소선·중단점·실패율` 같은 일반 명사의 일부는 상태로 읽지 않는다. 이 확인은 기존 접두 부정 처리와 함께 원문을 재작성하지 않는 단어 순회로 수행한다.

단계·상태 단어 안에 Markdown·링크·보이지 않는 문자·문자 엔티티가 끼는 경우도 검사한다. 서식 제거와 문자 정규화를 적용한 보조 텍스트에서 원문과 다른 단계·상태가 드러나면 ‘불명확’으로 추가해 차단한다. 이 보조 텍스트로 완료 근거를 새로 만들지 않으며, 기존 인용 예제와 원문 위치도 유지한다. 단계는 `장비 설치 확인`처럼 명확한 일반 표기를 사용하고, 밑줄은 기존 `<u>` 표기로 작성한다.
링크 주소의 중첩 괄호·이스케이프·제목은 수집기의 기존 분석기를 공유해 처리한다. 해석이 모호하거나 분석 제한을 넘는 링크가 있으면 해당 줄의 단계는 완료 근거에서 제외하므로, 원문에 맞는 중립 버전 표기나 명확한 일반 문장으로 작성한다. 링크 문법 참고: [CommonMark 링크 규칙](https://spec.commonmark.org/0.31.2/#links).

근거 구절 변조·다른 프로젝트로 이동·중복 선택·프로젝트 내 사용 가능한 수치 근거의 전부 생략은 차단하며 `VALIDATION_OVERRIDE`로 우회하지 않는다. 기존 Q/V 검증과 과거 catalog는 유지한다. 이 검사는 자유롭게 작성한 상위 설명의 의미나 적용 단계를 전부 증명하지 않으므로 최종 내용 검토가 필요하다. 코드식 API·시험 장비 명칭은 팀 독자가 이해할 업무 표현으로 작성하며, 알려진 명칭이 남으면 품질 검사에서 차단한다.

## 주간 pair 최선 게시와 검토 블록 (#138)

`MODE=weekly-pair-publish`의 `auto`는 검증에 실패한 주도 멈추지 않고 가능한 보고서를 게시하고, 위키 하단에 검토 블록을 붙인다. 같은 검증 실패라도 `MODE=update`는 기존대로 차단한다.

**게시 순서** (`lib/weekly-report-pair.js` `publishWeeklyPair`)

1. 통과한 summary → 검증 실패 후 보존한 summary → 통과한 depth2 → 통과한 depth3 순으로 고른다.
2. summary를 만들 수 없고 통과한 상세본도 없으면 거부된 depth2 → depth3 중 첫 사용 가능한 것을 문제 줄 포함 그대로 게시한다. 거부 후보는 파일 내용이 기록된 해시와 일치하고 섹션 헤더가 정확히 1개이며 경로가 pair 폴더 안으로 해석되어야 한다.
3. 후보가 없으면 `NO_PUBLISHABLE_REPORT`로 실패한다. exit가 0이 아니므로 기존 `[ALERT] … 보고 실패` 알림이 나간다.
4. depth를 2 또는 3으로 명시하면 실패한 변형은 여전히 게시 거부.
5. 거부 보고서 게시는 영수증에 `status: "rejected_published"`를 남긴다. 같은 날짜 재실행은 영수증이 지금 고른 거부 보고서(변형·depth·보고서 해시·`rejected_published`)와 정확히 같으면 쓰기 없이 skip(exit 0)하고, 다르면 `Already published`로 거부된다. `publication.started.json`만 있고 `completed`가 없는 중단 상태는 복구 승인이 필요하다.

팀 요약본은 프로젝트별 사실·출처 검증 오류가 있어도 다음 프로젝트를 한 번씩 생성하고,
합친 요약본을 기존 최종 검증에 넘긴다. 실패하면 검증 결과와 전체 거부 보고서를 보존해
검토 표시와 함께 게시한다. 잘못된 프로젝트·섹션 구조와 응답 없음·AI 호출 실패는 계속
생성을 중단하며, 완성된 요약본이 없으면 상세본을 선택한다. 일반 생성은 기존처럼 첫
프로젝트 검증 오류에서 중단한다. 이 정책은 이미 게시한 보고서를 자동으로 교체하지 않는다.

**검토 블록** (`lib/review-block.js` `buildReviewBlock`, `lib/publisher.js` `update`의 `options.reviewBlock`)

- `**검토 필요(자동)**`로 시작하고 `#` 헤더가 없다. 위치는 발표노트 블록 뒤, footer 앞.
- 내용: 게시한 변형(`요약본`/`depth2`/`depth3`으로 표시)과 통과/실패 상태, 실패 변형별 이슈 코드와 개수 및 error → warning 순서의 문제 줄 발췌(변형당 합쳐 최대 20줄, 줄당 최대 200자), summary 상태·사유와 gate 차단 코드 및 거부된 summary의 문제 줄 발췌(같은 상한), 수집 제외 근거(repo·ref·kind만), 생략된 모바일 브리핑.
- 이슈의 `message`/`evidence`와 제외된 근거의 원문은 넣지 않는다.
- 내용 검증은 블록 없는 섹션에, 헤더 수 검사는 블록 포함 최종 섹션에 적용한다.
- 블록을 포함한 게시 섹션은 보고서 옆 `*.published.md`(`buildPublishedPath`)에도 저장된다. 거부 보고서 게시도 같다(`lib/weekly-pipeline.js`).
- 발표노트 Redmine 이슈는 거부 경로에서도 ready 경로처럼 생성된다(`lib/presentation-note-flow.js`).
- 거부 보고서 게시 자체가 실패하면 `<OUTPUT_DIR>/pipeline/<date>/failures/`에 단계와 `serverState`(`unchanged`/`written_unverified`/`verified`)를 담은 JSON·Markdown 기록을 남기고 `[weekly][FAIL]`을 출력한다. 정상 변형의 기존 terminal 상태와 실패 기록은 보존한다. 기록은 비밀값을 가리며, `publication.started.json`만 남은 시도는 계속 복구 승인이 필요하다.
- 오류 메시지·스택·검증 이슈 필드는 축약 전에 공용 자격증명 탐지기로 검사하고, 의심 값이 있으면 필드 전체를 `[REDACTED]`로 바꾼다. 실행 환경과 게시 설정의 key/token/secret/password/authorization/webhook 값도 출력하지 않는다. 진단용 숫자·콜론 제한은 시간·소스 행 참조를 포함한 필드도 가릴 수 있으며, 단계·서버 상태는 별도 필드로 남긴다.
- 환경변수에 없는 설정값도 prepare 실패 기록과 pair 요약 실패 사유·경고에서 가린다.
- 실패 기록 파일을 쓰지 못했을 때도 최종 CLI `[error]` 출력에 실행 당시 설정을 사용해 같은 가림을 적용한다.

**수집 제외** (`lib/collector.js`, `lib/report-snapshot.js`)

- 커밋·PR·이슈 본문이 credential 검사에 걸리면 수집이 중단되지 않고 그 단위만 제외한다.
- snapshot에 `droppedEvidence: [{source, repo, ref, kind}]`로 기록한다. 새 수집·sealed snapshot 재사용·snapshot 로드 시 제외 항목마다 source·repo·ref·kind만 담은 `[collect][WARN]`을 출력한다. 형식이 맞지 않거나 자격증명이 의심되는 메타데이터도 그대로 출력하지 않는다.
- 검사 버전 상수 `COMMIT_BODY_CREDENTIAL_SCAN_VERSION`은 32다. Telegram 및 실제 설정의 자격증명 이름을 검사한다. 버전 31 snapshot은 수집 시 다시 만들고, generate/update/revalidate/publish에서는 재사용을 거부한다. 배포 전에 준비된 pair를 새 코드로 게시하지 말고 새 버전에서 다시 준비해야 한다.

**Slack 브리핑**: depth3 → 실패한 depth3가 남긴 원천 기록 → depth2(통과본 또는 실패 시 남긴 원천 기록) 순으로 만든다. `sourceDepth`와 안내 문구는 실제 원천을 나타내고, `slack.depth3.json` 파일 이름과 send의 바이트 대조 계약은 유지한다. 모두 없으면 WARN을 출력하고 브리핑을 건너뛰며(검토 블록에도 한 줄 기록) send는 실패하지 않는다. 변경 전 대체 원천으로 만든 브리핑은 새 코드에서 다시 준비해야 send의 내용 대조를 통과한다.

**검토 필요 알림**: 블록이 비어 있지 않으면 node가 `<OUTPUT_DIR>/pairs/<date>/review-needed.json`(`{schemaVersion, meetingDate, variant, label, codes}`; `variant`는 기계용 `summary`/`2`/`3`, `label`은 표시용 `요약본`/`depth2`/`depth3`)을 쓰고 `ALERT.log`에 `[WARN]`을 남긴다. `weekly-pair-publish`가 exit 0으로 끝나면 `run-report-env.sh`의 `notify_review_needed`가 `[REVIEW] <시각> redmine 검토 필요 — <회의 날짜> 변형 <label>, 사유 <codes> (위키 하단 참고)`를 기존 알림 채널(ALERT.log, notify-send, Telegram, Slack)로 한 번 보내고 `review-needed.notified`를 만든다. 파일을 읽지 못하면 폴더 이름의 날짜로 `<회의 날짜> (review-needed.json 읽기 실패)`를 보낸다. `MEETING_DATE`가 없으면 표식 없는 모든 `pairs/*/review-needed.json`을, 있으면 그 날짜만 본다.

**검토 방법**

1. 위키 해당 섹션 하단의 `**검토 필요(자동)**` 블록을 읽는다.
2. 보고서 옆 `*.published.md`로 게시된 전문을 확인한다.
3. `pairs/<date>/review-needed.json`의 변형·사유 코드, `out/ALERT.log`, `out/cron.log`로 원인을 추적한다.
4. 같은 보고서의 재실행은 skip되고, 다른 보고서로의 교체는 `Already published`로 막혀 있으므로 복구 승인이 필요하다.
5. `review-needed.notified`가 있으면 알림이 재전송되지 않는다. 다시 받으려면 이 파일을 지운다.

## 실패 코드별 대응

| 코드/상태 | 의미 | 대응 |
|---|---|---|
| `AI_PART_VALIDATION` | 프로젝트 파트가 사실 또는 section/source 계약을 위반 | 실패 파트 원문과 `state.json.partFailure.issues` 확인 |
| `AI_TIMEOUT` | 단일 호출이 `AI_TIMEOUT_MS` 초과 | 실제 소요시간을 확인한 뒤 timeout을 명시적으로 조정 |
| `AI_QUOTA` | provider 사용량 또는 quota 소진 | 다른 provider로 자동 전환하지 말고 복구 후 수동 재실행 |
| `AI_INPUT_LIMIT` | 호출 prompt가 문자 수 상한 초과 | `project` 파일럿 또는 입력 중복 원인 검토 |
| `WARNING` | advisory 이슈만 존재 | `publishable`과 warning 내용을 확인한 뒤 게시 여부 판단 |
| `FAIL`/`ERROR` | blocking 검증 또는 실행 실패 | `MODE=update`를 실행하지 않음 |

## 동일 Snapshot 비교

비교 도구는 generate만 실행하며 Redmine update를 호출하지 않는다.

```bash
node scripts/ai-provider-scope-spike.js \
  --snapshot /absolute/path/report-2026-08-26.snapshot.json \
  --meeting-date 2026-08-26 \
  --output-dir /absolute/path/out/spikes/provider-scope \
  --depth 3 --effort medium --timeout-ms 900000
```

일부 후보만 실행하려면 `--only`에 비교 ID를 쉼표로 지정한다.

```bash
node scripts/ai-provider-scope-spike.js \
  --snapshot /absolute/path/report-2026-08-26.snapshot.json \
  --meeting-date 2026-08-26 \
  --output-dir /absolute/path/out/spikes/project-only \
  --only claude-sonnet-project,codex-gpt-5.6-sol-project \
  --depth 3 --effort medium --timeout-ms 900000
```

결과는 `<output-dir>/comparison.json`에 검증 상태, 이슈 집계, source coverage, 줄·불릿·leaf 중복, 소요시간과 호출 증거를 기록한다. `plannedCalls`는 해당 run의 `prompt-input.json`에 기록된 계획 호출 수이고, `actualCalls`는 `draft.ai.annotated.md` 또는 `draft.ai.part.NNN.annotated.md`로 완료 응답이 보존된 수다. timeout처럼 응답 산출물이 없는 호출은 `actualCalls`에 포함되지 않는다.
