# 보고서 AI 공급자·생성 범위 선택 설계

## 배경

평소 주간 보고 입력은 한 번의 AI 호출로 처리할 수 있지만, 2026-08-26 스냅샷처럼 작업량이 많은 주에는 긴 입력 안에서 서로 다른 근거가 섞일 위험이 커진다. 실제 depth3 파일럿에서는 PIM 내부의 `4채널` 근거가 다른 PIM 항목으로 이동해 원본에 없는 수치가 생성됐고 전체 검증기가 게시를 차단했다.

작업량이 적은 주까지 항상 세 번 호출할 필요는 없다. 따라서 기존 전체 생성은 기본값으로 보존하고, 사용자가 PIM/Wireless Lan/ETC 분할 생성을 선택할 수 있게 한다. Claude만 전제하던 실행 경계도 공급자 인터페이스로 좁혀 Sonnet, Opus, Codex를 동일한 사실·source 계약으로 비교할 수 있게 한다.

## 목표

- `AI_GENERATION_SCOPE=whole|project`로 전체 생성과 프로젝트별 분할 생성을 선택한다.
- 기본값 `whole`은 현재 한 번 호출 동작과 산출물 계약을 유지한다.
- `project`는 PIM, Wireless Lan, ETC를 고정 순서로 각각 한 번 생성한 뒤 결정적으로 병합한다.
- `AI_PROVIDER=claude|codex`와 `AI_MODEL`로 실행 공급자와 모델을 지정한다.
- 모든 공급자와 생성 범위가 동일한 fact/source 검증을 통과해야 게시 가능하다.
- 줄 수를 새로운 차단 기준으로 만들지 않는다. 같은 작업의 커밋, 리뷰, 후속 수정과 동일 source의 반복을 줄이는 것을 우선한다.

## 비목표

- 입력 크기에 따른 자동 범위 전환은 이번 변경에 포함하지 않는다.
- 실패한 호출의 자동 재시도나 다른 공급자로의 자동 fallback은 추가하지 않는다.
- 검증 실패를 완화하거나 우회하지 않는다.
- PIM 내부를 Application/Test 같은 하위 범위로 다시 분할하지 않는다.
- Codex를 검증 전에 운영 기본값으로 채택하지 않는다.

## 설정 계약

| 환경변수 | 허용값 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `AI_PROVIDER` | `claude`, `codex` | `claude` | 텍스트 생성 CLI |
| `AI_MODEL` | 비어 있지 않은 문자열 | 공급자별 기본값 | Claude는 `sonnet`, Codex는 `gpt-5.6-sol` |
| `AI_EFFORT` | 기존 허용값 | `low` | 공급자에 전달할 추론 강도 |
| `AI_GENERATION_SCOPE` | `whole`, `project` | `whole` | 전체 한 번 또는 최상위 프로젝트별 생성 |
| `CLAUDE_CLI` | 실행 경로 | `claude` | Claude CLI |
| `CODEX_CLI` | 실행 경로 | `codex` | Codex CLI |

`AI_MODEL`을 명시하면 공급자 기본값보다 우선한다. 기존 설정 파일의 `defaults.aiModel=sonnet`은 Claude 기본값으로 호환하되 Codex 선택 시에는 `gpt-5.6-sol`을 사용한다.

## 공급자 실행

Claude는 기존 `--safe-mode`, 빈 tools, 세션 비저장, 모델, effort, 선택적 예산, 텍스트 출력 계약을 유지한다.

Codex는 비대화형 `codex exec`를 사용한다. 실행은 임시 세션, 읽기 전용 sandbox, 사용자 설정 비활성, 명시 모델·reasoning effort로 제한하고 프롬프트는 stdin으로 전달한다. 최종 stdout만 보고서 후보로 사용하며 진행 이벤트는 stderr에 남긴다. 저장된 Codex 인증은 재사용하되 API 키나 인증 파일은 산출물에 기록하지 않는다.

공급자 오류는 공통 `AiSummaryError` 코드로 노출한다. 로그와 `prompt-input.json`에는 provider, model, effort, scope, 호출 수를 남긴다.

## 생성 범위

### whole

현재와 동일하게 전체 annotated source로 프롬프트 하나를 만들고 한 번 호출한다. 기존 raw AI draft와 prompt hash 의미를 보존한다.

### project

1. 설정된 category의 parent 순서에서 `PIM`, `Wireless Lan`, `ETC` 최상위 범위를 구한다.
2. 원본의 조현우 header와 해당 최상위 bullet subtree만 포함한 입력 세 개를 만든다.
3. 각 입력에 동일한 fact/source 계약과 해당 범위 밖 내용을 만들지 말라는 범위 지시를 추가한다.
4. PIM→Wireless Lan→ETC 순서로 호출한다. 호출 실패나 부분 검증의 blocking 오류가 나오면 다음 호출 없이 종료한다.
5. 각 출력에서 조현우 header와 해당 최상위 subtree만 받아 단일 header 아래에 고정 순서로 병합한다.
6. 병합한 annotated draft에 기존 reference 확장, source heading 정규화, open-status 정규화, 전체 V2 검증을 그대로 적용한다.

Notion N marker 누락·중복은 기존 정책대로 경고다. canonical C marker, fact marker, 범위 위반은 오류다. 분할 모드가 검증 기준을 강화하거나 완화하지 않는다.

## 중복 제거 지시

- 동일 작업의 구현 커밋, 리뷰 반영, 후속 수정은 결과 중심 한 항목으로 합친다.
- 같은 source marker 또는 사실상 동일한 근거를 여러 문장에 반복하지 않는다.
- 공통 자동화 적용처럼 여러 프로젝트에 반복된 항목은 실제 귀속 프로젝트 또는 ETC에 한 번만 둔다.
- 서로 다른 기능, 컴포넌트, 검증 결과는 중복으로 보지 않고 합치지 않는다.
- 줄 수와 bullet 수는 측정값이며 새로운 게시 차단 기준이 아니다.

## 산출물

`prompt-input.json`은 전체 모드의 기존 필드에 provider와 scope를 추가한다. 분할 모드에서는 각 범위의 prompt hash와 길이를 배열로 기록하고, 전체 plan hash를 기존 `promptHash` 자리에 기록한다. `draft.ai.annotated.md`는 공급자별 원시 스트림이 아니라 전체 검증에 투입된 병합 annotated draft를 저장한다.

## 검증 및 비교

구현 후 동일한 2026-08-26 sealed snapshot, depth3, medium effort로 아래 여섯 조합을 실행한다.

- Claude Sonnet: whole, project
- Claude Opus: whole, project
- Codex GPT-5.6 Sol: whole, project

전체 모드는 각 1회, project는 각 3회로 최대 12회 호출한다. 자동 재시도와 Redmine update는 금지한다. 조합별로 전체 검증 상태, blocking 코드, 원본 근거 없는 사실, canonical coverage, 정규화된 중복 bullet, 출력 길이, 실행 시간을 비교한다. Codex가 불리하거나 검증 실패가 많으면 선택지는 유지할 수 있어도 운영 기본값으로 채택하지 않는다.
