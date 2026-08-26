# 주간보고 사실 계약 및 실패 산출물 재사용 설계

- 작성일: 2026-08-26
- 상태: 설계 승인 대기(사용자 리뷰)
- 대상 저장소: `/home/jhw/ai/opencode/projects/redmine`
- 관련 이슈: GitHub #25 `fix(report): validation 실패 시 AI 산출물 폐기율 축소 및 실패 원인 수렴`
- 선행 작업: GitHub #24 AI 실행 예산 및 중복 게시 제한

## 1. 배경과 사고 판정

2026-08-26 KST 주간보고 `generate`는 Claude 응답을 한 번 정상 수신했지만 사실 검증에서 실패했다.

- 원본에 있던 `5/8 PASS` 등과 일치하지 않는 `10건 PASS, 실패 1건`을 생성했다.
- 원본의 수량 표현과 결속되지 않은 `16개`를 생성했다.
- 검증기는 각각 `unsupported_test_result`, `unsupported_fact_token`으로 차단했다.
- `update`도 Redmine API 호출 전에 중단했다.
- 이후 수동 수정 과정에서 당시 AI 초안이 기존 canonical 경로에서 덮어써져, 원문 오류 표현은 cron 로그에만 남았다. 이는 run별 immutable 원본 보존이 필요한 직접 근거다.

검증기 핵심 로직은 사고 당시 의도대로 동작했다.

- `extractTestFacts()`는 PASS/FAIL 수치를 구조화했다.
- `testFactSupported()`는 pass/total/fail tuple의 완전 일치를 요구했다.
- `extractProtectedTokens()`는 수치·버전·단위 토큰을 대조했다.

따라서 이 작업은 검증을 느슨하게 만드는 버그 수정이 아니다. 생성기가 사용할 수 있는 사실을 원문에 결속하고, 실패한 고비용 산출물을 덮어쓰지 않으며, 사람이 추가 AI 호출 없이 고칠 수 있게 하는 계약 변경이다.

현재 프롬프트에는 이미 “원본에 없는 숫자를 만들거나 변경하지 않는다”는 문구가 있지만, 이어지는 규칙이 PASS 표현을 다른 형태로 바꾸도록 허용한다. 자유로운 표기 변환 과정에서 집계·환산·조수사 변경이 일어날 여지가 있으므로 schema v2 자동 생성 경로는 원문 표기 복사를 기본 계약으로 삼는다.

## 2. 목표

1. Claude가 사용할 수 있는 수치·버전·날짜·테스트 결과를 기계 판독 가능한 근거 ID에 결속한다.
2. 자동 생성에서는 보호 사실의 숫자, PASS 표기, 단위와 조수사를 원문 그대로 복사한다.
3. 허용되지 않은 사실과 의미가 달라진 표현은 계속 fail-closed한다.
4. 검증 실패 시 offending value, 기대 근거, 원본 위치, 출력 위치를 함께 남긴다.
5. 모든 생성 시도의 원본 AI 응답과 검증 결과를 run ID별로 보존한다.
6. 실패한 초안을 사람이 수정한 뒤 Claude 재호출 없이 재검증하고 승격할 수 있게 한다.
7. validation 오류 하나가 다른 위치의 오류 진단을 가리지 않게 한다.

## 3. 비목표

- 모델, effort, 입력 크기, 호출 횟수, timeout 예산 변경: #24에서 처리했다.
- validation 실패 후 자동 LLM 재시도 또는 LLM 기반 교정.
- 허용되지 않은 사실을 경고로 낮추거나 Redmine 게시를 계속하는 동작.
- 과거 schema v1 산출물의 일괄 변환.
- run 산출물의 자동 삭제 및 보존 기간 정책.
- Redmine Wiki/Issue API 계약 변경.

## 4. 선택한 접근

### 4.1 근거 카탈로그 + 주석형 Markdown

기존 Markdown 생성 흐름을 유지하되 보호 사실을 다음 형식으로 출력한다.

```text
[[fact:T0003|5/8 PASS]]
[[fact:Q0012|16건]]
```

- `T`: 테스트 결과
- `Q`: 수량·측정값·단위
- `V`: 버전·16진수 등 식별성 수치
- `S`: 회의일처럼 시스템이 명시적으로 제공한 사실

검증 성공 후 `[[fact:<id>|`와 마지막 `]]`만 제거해 사람이 읽는 Markdown을 만든다. Redmine에는 마커가 노출되지 않는다.

### 4.2 대안과 제외 이유

- JSON 응답(`report` + `claims`)은 더 엄격하지만 모델 출력 파싱 계층과 수동 편집 비용이 커서 제외한다.
- 프롬프트 강화만으로는 같은 숫자가 다른 대상을 세는 문제와 원본 위치 진단을 해결할 수 없어 제외한다.

## 5. 컴포넌트 경계

### 5.1 `lib/fact-catalog.js`

sealed snapshot의 `rawContent`와 시스템 사실로 deterministic fact catalog를 만든다.

책임:

- 기존 PASS/FAIL 및 보호 토큰 추출 규칙을 재사용한다.
- Set 기반 결과와 별도로 모든 occurrence의 `start`, `end`, `line`, `column`을 보존한다.
- 같은 문자열이 여러 번 나와도 원본 위치별로 별도 ID를 부여한다.
- 원본 순서와 사실 유형 순서로 ID를 결정해 같은 snapshot에서는 항상 같은 카탈로그를 만든다.
- 사실이 센 대상 또는 속한 줄의 문맥을 `subject`와 `sourceExcerpt`에 보존한다.
- 카탈로그 전체를 stable JSON으로 직렬화해 `catalogHash`를 계산한다.

카탈로그 항목 예시:

```json
{
  "id": "T0003",
  "type": "test_result",
  "raw": "5/8 PASS",
  "semantic": {"pass": 5, "total": 8, "fail": 3},
  "subject": "보드 실행",
  "sourceLocation": {"line": 143, "column": 38, "start": 9210, "end": 9218},
  "sourceExcerpt": "보드 실행 5/8 PASS(board_error_detect, BSP 부팅 잡음)",
  "allowedNormalizations": ["whitespace_around_slash"]
}
```

### 5.2 `lib/annotated-draft.js`

주석형 Markdown의 구문을 담당하는 순수 모듈이다.

책임:

- `[[fact:<id>|<surface>]]` 파싱과 위치 계산.
- 중첩 마커, 닫히지 않은 마커, 빈 ID/표시값을 오류로 반환.
- 검증된 주석형 초안에서 마커만 제거해 clean Markdown 생성.
- clean Markdown을 직접 다시 주석형으로 추론하지 않음.

`surface`는 숫자 사실의 짧은 원문이므로 `[[`, `]]`를 포함할 수 없다. 해당 문자가 발견되면 escape를 시도하지 않고 malformed marker로 차단한다.

### 5.3 `lib/fact-validator.js`

schema v1의 기존 검증 함수는 호환 경로로 유지한다. schema v2에는 카탈로그와 주석형 초안을 받는 검증 경계를 추가한다.

schema v2 책임:

- 모든 fact marker의 ID가 카탈로그에 존재하는지 확인.
- marker의 `surface`가 해당 ID의 원문 또는 폐쇄형 안전 정규화에 해당하는지 확인.
- 마커가 제거된 위치를 다시 검사해 보호 수치가 marker 밖에 남아 있으면 차단.
- 수량·측정 사실은 marker 주변에서 기존 결정적 parser가 추출한 counted target/metric label을 카탈로그의 `subject`와 비교한다. 둘이 다르면 차단한다.
- 테스트 결과처럼 출력 문맥의 subject를 결정적으로 추출할 수 없는 유형은 임의 NLP 추론을 하지 않는다. ID·surface 완전 일치와 프롬프트의 원문 문맥 복사 규칙으로 결속한다.
- 기존 open-status, section header, markup 및 git pickaxe 검증을 계속 수행.
- 첫 오류에서 중단하지 않고 전체 초안을 순회해 모든 오류를 수집.

### 5.4 `lib/report-run.js`

run 디렉터리, 상태 전이, 검증 성공 보고서 승격을 담당한다.

책임:

- run ID 생성과 안전한 경로 해석.
- run 산출물을 atomic write로 저장.
- 상태 전이와 snapshot/catalog hash 소유권 확인.
- validation 성공 시 clean Markdown을 기존 보고서 경로로 atomic 승격.
- 기존 `<report>.generation.json`이 현재 run과 승격된 보고서를 가리키게 함.

## 6. 생성 프롬프트 계약

fact catalog는 ready-to-copy 목록으로 원본 보고서 앞에 제공한다. 모델에는 다음 규칙을 명시한다.

1. 수치·버전·날짜·PASS/FAIL 결과가 필요하면 카탈로그의 marker 전체를 그대로 복사한다.
2. marker의 `surface`에 있는 숫자, 표기 순서, 단위, 조수사를 바꾸지 않는다.
3. `PASS N/M`, `N/M PASS`, `N건 PASS, 실패 M건` 사이를 자동 변환하지 않는다.
4. `개`, `건`, `회`, 물리 단위와 버전 접두를 임의 변경하지 않는다.
5. 여러 근거를 합산·차감·집계해 새로운 숫자를 만들지 않는다.
6. 환산, 비율 계산, 평균, 반올림, 범위 축약을 하지 않는다.
7. 카탈로그에 없는 숫자가 필요하면 문장에서 숫자를 생략한다.
8. 사용하지 않는 사실은 marker를 출력하지 않는다.

즉 자동 생성의 기본은 의미 동등 변환이 아니라 원문 literal 복사다. 안전 정규화는 검증기의 좁은 호환 경계일 뿐, 모델에 표기 변경 권한을 주지 않는다.

## 7. 정규화 정책

schema v2에서 허용하는 정규화는 수치 의미와 단위를 바꾸지 않는 폐쇄형 규칙만 가능하다.

허용:

- `/` 주변 공백 차이.
- 기존 검증 계약에 있는 버전 `v` 접두의 추가·제거. 단, 숫자 부분은 완전 일치해야 한다.
- `x`와 `×`처럼 이미 같은 차원 표기로 정의된 문자 차이.

금지:

- `5/8 PASS`를 `10/11 PASS` 또는 `10건 PASS, 실패 1건`으로 변경.
- `16건`을 `16개`로 변경. 센 대상이 같아도 schema v2에서는 허용하지 않는다.
- `PASS N/M`과 `N/M PASS` 사이의 의미 추론 또는 표기 재배열.
- total-pass 같은 산술로 새로운 fail 수치를 생성.
- 여러 행의 수치를 합산하거나 대표값으로 변경.
- 단위 환산, 백분율 계산, 평균, 반올림.
- 결정적으로 counted target/metric label을 추출할 수 있는 유형에서 숫자는 같지만 다른 `subject`의 근거 ID 사용.

schema v1의 `GENERIC_COUNTER_TOKEN` 예외는 기존 산출물 호환을 위해 유지한다. schema v2 자동 생성과 재검증에는 적용하지 않는다.

## 8. run 산출물과 상태

각 generate 시도는 다음 경로를 사용한다.

```text
out/runs/<meetingDate>/<attemptId>/
  state.json
  fact-catalog.json
  prompt-input.json
  draft.ai.annotated.md       # 최초 AI 응답, immutable
  draft.working.annotated.md  # 수동 수정 대상
  validation.001.json
  validation.002.json         # 재검증마다 revision 증가
  report.clean.md             # 검증 성공 시에만 생성
```

`prompt-input.json`에는 prompt 전체를 중복 저장하지 않고 snapshot path/hash, catalog hash, prompt hash, 모델 설정, 입력 문자 수를 저장한다. 실제 AI 응답은 `draft.ai.annotated.md`에 원문 그대로 보존하고, 같은 내용으로 `draft.working.annotated.md`를 최초 한 번 만든다. 이후 수동 편집은 working copy만 변경한다. `state.json`은 run 디렉터리 기준 상대 파일명인 `latestValidationPath`와 validation revision을 가리키며 이전 validation 파일은 덮어쓰지 않는다.

상태 전이:

```text
running
  ├─ ai_failed          # quota, budget, timeout, exit 등
  └─ ai_complete
       ├─ validation_failed
       └─ complete
validation_failed
  └─ complete           # 수동 수정 후 revalidate 성공
```

- 상태 전이는 현재 attempt ID를 소유한 실행만 기록한다.
- validation 실패는 같은 run에서 두 번째 Claude 호출을 절대 시작하지 않는다.
- 실패해도 최초 `draft.ai.annotated.md`와 기존 validation revision을 덮어쓰거나 삭제하지 않는다.
- canonical 보고서 경로는 validation 성공 전까지 변경하지 않는다.
- 자동 보존 기간과 삭제는 이 설계에서 다루지 않는다.

## 9. validation 결과 계약

validation schema v2 오류는 가능한 경우 다음 필드를 포함한다.

```json
{
  "severity": "error",
  "code": "fact_value_mismatch",
  "value": "10건 PASS, 실패 1건",
  "factId": "T0003",
  "expected": ["5/8 PASS"],
  "sourceLocation": {"line": 143, "column": 38},
  "sourceExcerpt": "보드 실행 5/8 PASS(board_error_detect, BSP 부팅 잡음)",
  "outputLocation": {"line": 40, "column": 15},
  "outputExcerpt": "결과: 10건 PASS, 실패 1건"
}
```

주요 오류 코드:

- `malformed_fact_marker`
- `unknown_fact_id`
- `fact_value_mismatch`
- `fact_subject_mismatch`
- `unmarked_protected_fact`
- 기존 `unsupported_test_result`, `unsupported_fact_token`
- 기존 구조·open-status·pickaxe 오류 코드

validation은 전체 오류를 배열로 남긴다. 한 섹션의 오류가 다른 섹션의 유효성이나 오류 위치를 숨기지 않는다.

validation schema v2 최상위에는 `attemptId`, `snapshotHash`, `catalogHash`, `annotatedDraftHash`, `checkedAt`, `issues`를 기록한다. 성공 revision에는 marker 제거 결과의 `cleanReportHash`도 기록한다. 실패 revision에는 `cleanReportHash`를 기록하지 않아 승격 가능한 산출물로 오인되지 않게 한다.

## 10. 수동 재검증

실행 계약:

```bash
MODE=revalidate RUN_ID=<attemptId> MEETING_DATE=YYYY-MM-DD node index.js
```

절차:

1. `RUN_ID`는 UUID 형식만 허용하고 `realpath`가 해당 날짜의 run root 안인지 확인한다.
2. `state.json`, sealed snapshot, `fact-catalog.json`을 읽는다.
3. snapshot hash와 catalog hash가 run 생성 당시 값과 일치하는지 확인한다.
4. 사람이 수정한 `draft.working.annotated.md`를 schema v2로 검증한다.
5. 성공·실패와 관계없이 다음 번호의 validation revision을 새 파일로 atomic 저장한다. 실패하면 상태를 `validation_failed`로 유지한다.
6. 성공하면 `report.clean.md`를 만들고 기존 보고서 경로로 atomic 승격한다.
7. global generation state를 같은 attempt ID의 `complete`로 전환한다.

`MODE=revalidate`는 `aiSummarize()`나 Claude CLI spawn 경로를 호출하지 않는다. `AI_SUMMARIZE=1`이어도 호출 횟수는 0이다.

수동 편집은 clean 보고서나 immutable AI 응답이 아니라 run의 `draft.working.annotated.md`에서 수행한다. schema v2의 clean 보고서가 승격 뒤 직접 변경되면 update는 hash 불일치로 차단하고 revalidate 절차를 안내한다.

## 11. update 게시 게이트

schema v2 update는 다음을 모두 만족해야 Redmine 변경을 시작한다.

- generation state가 `complete`다.
- meeting date, report depth, snapshot hash, attempt ID가 일치한다.
- validation schema가 v2이고 catalog hash가 일치한다.
- canonical 보고서 hash가 validation의 `cleanReportHash`와 일치한다.
- 게시 시점에도 구조, open-status 및 git pickaxe 검증을 다시 통과한다.

사실 검증은 생성 당시의 sealed snapshot/catalog와 clean report hash로 고정한다. 반면 최신 git 상태에 따라 결과가 달라질 수 있는 open-issue 검증은 update 직전에 다시 실행한다.

schema v1 generation state는 기존 `validateDraft()` 경로로 처리한다. 이 호환 경로는 generate와 update 사이에 배포가 일어나도 기존 초안 게시를 불필요하게 막지 않기 위한 것이다.

발표노트 Issue 생성과 Redmine Wiki PUT은 위 게이트를 모두 지난 뒤에만 실행한다.

## 12. 테스트 전략

### 12.1 fact catalog 단위 테스트

- 동일 snapshot에서 ID와 catalog hash가 결정적이다.
- 같은 문자열의 여러 occurrence가 서로 다른 위치와 ID를 가진다.
- test result semantic tuple과 원문 위치가 정확하다.
- 수량의 숫자·조수사·subject가 함께 보존된다.
- meeting date 같은 시스템 사실이 `S` 항목으로 분리된다.

### 12.2 주석형 초안 단위 테스트

- 정상 marker parse와 clean rendering.
- 중첩·미종료·빈 ID·빈 surface 차단.
- output line/column 계산.
- marker 밖 보호 수치 차단.

### 12.3 실제 사고 fixture

- 원본 `5/8 PASS` → `[[fact:T0001|5/8 PASS]]`: 통과.
- 원본 `5/8 PASS` → `[[fact:T0001|10/11 PASS]]`: 실패.
- 원본 `5/8 PASS` → `[[fact:T0001|10건 PASS, 실패 1건]]`: 실패.
- 원본 `16건 저장소 전면 배포` → `[[fact:Q0001|16개]] 저장소 전면 배포`: 실패.
- counted target을 결정적으로 비교할 수 있는 수량에서 같은 숫자를 다른 subject의 ID로 결속: 실패.
- 합산·환산·반올림으로 만든 수치: marker가 없어 실패.

### 12.4 run 통합 테스트

- fake Claude CLI는 generate당 정확히 한 번만 실행된다.
- validation 실패 후 CLI 호출 수가 늘지 않는다.
- immutable AI draft, working draft, 모든 validation revision이 run ID 경로에 남는다.
- 실패 시 기존 canonical 보고서가 변경되지 않는다.
- 수정 후 `revalidate`는 Claude 호출 0회로 성공하고 clean 보고서를 atomic 승격한다.
- 하나의 초안에서 여러 섹션 오류가 모두 진단된다.
- 잘못된 UUID, 경로 탈출, snapshot/catalog hash 불일치를 차단한다.
- schema v1 update 호환과 schema v2 hash 게이트를 각각 검증한다.

### 12.5 외부 경계 테스트

- 실제 Claude/Redmine API를 호출하지 않는다.
- fake CLI와 localhost HTTP 서버로 Claude 호출 계약 및 Redmine 호출 전 게이트를 검증한다.
- validation 실패와 revalidate 실패에서는 localhost Redmine 요청도 0건이어야 한다.

## 13. 운영 및 롤아웃

1. schema v2 생성 기능과 schema v1 update 호환을 함께 배포한다.
2. 실제 snapshot 기반 fixture로 generate dry-run을 수행하되 fake Claude 응답을 사용한다.
3. 수동 pilot에서 run 산출물, 오류 위치, revalidate, atomic 승격을 확인한다.
4. 다음 cron부터 schema v2를 기본으로 사용한다.
5. `running`, `ai_complete`, `validation_failed`, `complete` 상태와 artifact 경로를 cron 로그에 남긴다.
6. 첫 운영 주에는 validation 오류 코드와 unmarked fact 수를 확인한다.

## 14. 완료 조건

- [ ] 허용되지 않은 사실은 계속 게시를 차단한다.
- [ ] 자동 생성은 숫자·PASS 표기·단위·조수사를 원문 그대로 복사한다.
- [ ] 안전한 표기 차이만 폐쇄형 정규화로 처리한다.
- [ ] 의미가 달라지는 수치 합성·추론·환산·반올림은 차단한다.
- [ ] 오류에 offending value, fact ID, 기대 원문, source/output 위치가 포함된다.
- [ ] 실패 초안과 validation이 run ID별로 보존된다.
- [ ] 실패 초안을 Claude 호출 없이 수정·재검증·승격할 수 있다.
- [ ] validation 실패 하나가 다른 섹션의 진단을 가리지 않는다.
- [ ] 실제 `5/8`, `10건 PASS, 실패 1건`, `16개` 사고 fixture가 회귀 테스트에 포함된다.
- [ ] schema v1 배포 중간 호환과 schema v2 publish hash 게이트가 검증된다.
- [ ] 기본 generate 경로의 Claude 호출 상한은 1회이며 validation 실패 재호출은 0회다.

## 15. 결정 사항

- 검증기 정확성은 약화하지 않는다.
- schema v2 자동 생성은 exact-copy first다.
- 조수사 변경은 같은 대상을 세더라도 schema v2에서 허용하지 않는다.
- 실패 산출물은 canonical 보고서와 분리해 run ID로 보존한다.
- 수동 수정 진입점은 annotated draft + `MODE=revalidate`다.
- clean 보고서 직접 수정은 schema v2 update에서 차단한다.
- run artifact 자동 삭제는 후속 정책으로 남기고 #25에 포함하지 않는다.
