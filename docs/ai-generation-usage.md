# 주간보고 AI 생성 사용 가이드

이 문서는 `MODE=generate`에서 사용할 AI 실행기(provider), 모델, 보고서 상세도와 생성 범위를 설정하는 방법을 설명한다. `generate`는 sealed snapshot을 읽어 로컬 보고서와 검증 산출물만 만들며 Redmine에는 쓰지 않는다. 실제 게시에는 별도의 `MODE=update` 실행이 필요하다.

## 기본 운영값

환경변수를 지정하지 않으면 다음 조합을 사용한다.

```text
AI_PROVIDER=claude
AI_MODEL=sonnet
AI_EFFORT=low
AI_GENERATION_SCOPE=whole
REPORT_DEPTH=2
AI_TIMEOUT_MS=300000
```

주간 운영에서는 기존 cron과 같은 `Claude Sonnet + whole`을 유지한다. Codex와 `project` 분할은 명시적으로 선택할 때만 사용한다.

## 설정 우선순위

AI 설정은 환경변수가 `repo-config.json`의 `defaults`보다 우선한다.

| 환경변수 | 값 | 기본값 | 설명 |
|---|---|---|---|
| `AI_SUMMARIZE` | `0` 또는 `1` | `0` | `1`일 때만 AI 요약과 schema v2 검증을 실행한다. |
| `AI_PROVIDER` | `claude`, `codex` | `claude` | 사용할 CLI 실행기다. 잘못된 값은 호출 전에 차단된다. |
| `AI_MODEL` | provider가 지원하는 모델명 | Claude `sonnet`, Codex `gpt-5.6-sol` | 환경변수로 지정하면 provider별 기본 모델보다 우선한다. |
| `AI_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` | `low` | CLI에 전달하는 reasoning effort다. |
| `AI_GENERATION_SCOPE` | `whole`, `project` | `whole` | 전체 1회 생성 또는 최상위 프로젝트별 순차 생성을 선택한다. |
| `REPORT_DEPTH` | `1`, `2`, `3`, `4` | `2` | 1=요약, 2=표준, 3=중간, 4=상세다. |
| `AI_MAX_INPUT_CHARS` | 양의 정수 | `100000` | 호출별 전체 prompt 문자 수 상한이다. 초과하면 CLI를 실행하지 않는다. |
| `AI_TIMEOUT_MS` | 양의 정수 | `300000` | AI 단일 호출 timeout이다. `project` 전체가 아니라 각 파트에 적용된다. |
| `AI_MAX_BUDGET_USD` | 양수 | 미설정 | Claude CLI에만 `--max-budget-usd`로 전달한다. |
| `CLAUDE_CLI` | 실행 파일 경로/이름 | `claude` | Claude CLI를 바꿀 때 사용한다. |
| `CODEX_CLI` | 실행 파일 경로/이름 | `codex` | Codex CLI를 바꿀 때 사용한다. |

`AI_PROVIDER=codex`이고 `AI_MODEL`이 없으면 `repo-config.json`의 `codexModel`을 사용한다. Claude를 선택하면 `aiModel`을 사용한다. provider 변경 시 다른 provider로 자동 fallback하지 않으며, 실패한 호출도 자동 재시도하지 않는다.

## Provider와 모델 선택

### Claude Sonnet

평소 운영 권장값이다. 기존 동작과 가장 가깝다.

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

현재 운영 기본값이 아닌 A/B 후보다. `gpt-5.6-sol` 이외의 모델을 시험할 때는 `AI_MODEL`을 함께 지정한다.

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
| 평소 주간 운영 | Claude Sonnet | `whole` | 3 | 현재 cron과 가장 가까운 안전한 선택 |
| 평소보다 입력이 큰 주 | Claude Sonnet | `project` | 3 | 파일럿으로 실행하고 파트 검증 결과를 확인 |
| 간결성 A/B 비교 | Codex `gpt-5.6-sol` | `whole` | 3 | 한 주 표본에서는 가장 간결했지만 기본값은 아님 |
| 모델 상향 비교 | Claude Opus | `whole` | 3 | 비용·시간 증가가 검증 통과를 보장하지 않음 |

`project`가 실패했다고 검증 기준을 완화하거나 자동으로 `whole`을 재호출하지 않는다. 같은 sealed snapshot으로 설정을 명시해 새 generate를 실행한다.

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

결과는 `<output-dir>/comparison.json`에 검증 상태, 이슈 집계, source coverage, 줄·불릿·leaf 중복, 소요시간과 실제 호출 수로 기록된다.
