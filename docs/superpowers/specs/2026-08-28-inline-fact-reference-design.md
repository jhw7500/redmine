# 인라인 사실 참조 설계

- 작성일: 2026-08-28
- 상태: 승인됨(2026-08-28)
- 선행 설계: `2026-08-26-report-fact-contract-design.md`
- 범위: schema v2 AI generate 입력과 AI 응답 직후의 결정적 변환

## 1. 문제

현재 schema v2 generate는 원문 43,561자와 별도 fact catalog 33,334자를 같은 프롬프트에 넣는다. 2026-08-28 파일럿의 전체 입력은 88,836자였고, Claude는 catalog의 full marker 377개를 하나도 출력하지 않았다. 출력의 보호 사실 38개는 모두 `unmarked_protected_fact`로 차단됐으며 그중 하나는 원문 `4`를 `4개`로 바꾼 표현이었다.

검증기는 의도대로 fail-closed했지만, 생성기가 별도 catalog에서 marker를 찾아 원문의 숫자 대신 다시 출력해야 하는 계약은 확률적 모델에 지나치게 많은 정확성을 요구한다. 프롬프트 강화만으로는 이 경계를 결정적으로 만들 수 없다.

## 2. 목표

1. Claude가 보호 숫자·버전·날짜·단위를 직접 다시 쓰지 않게 한다.
2. fact ID를 원문 문맥의 정확한 위치에 결속한다.
3. 별도 sourceExcerpt catalog의 프롬프트 중복을 제거한다.
4. 기존 full marker validator, run artifact, 수동 revalidate, update 게시 게이트를 유지한다.
5. 알 수 없는 참조, 변형된 참조, 참조 밖 보호 사실은 계속 차단한다.

## 3. 선택한 접근

### 3.1 원문 인라인 불투명 참조

catalog의 `sourceLocation`을 사용해 AI 입력용 원문만 다음처럼 바꾼다.

```text
입력 원문: 보드 실행 5/8 PASS
AI 입력:   보드 실행 [[fact:T0001]]
```

`[[fact:T0001]]`에는 숫자 surface가 없으므로 모델은 `5/8`을 `10/11`로 바꿀 수 없다. 해당 사실이 필요한 문장을 유지할 때는 참조 전체를 그대로 복사한다. 사용하지 않는 사실 참조는 생략할 수 있다.

`sourceLocation: null`인 시스템 사실은 compact system-fact 목록과 관련 규칙 안에서 참조만 제공한다. 회의 기준일은 literal 날짜 대신 `[[fact:S0001]]`로 지시한다.

### 3.2 결정적 확장

AI 응답을 section sanitizer로 정리한 직후, 알려진 bare reference를 catalog surface가 포함된 기존 marker로 확장한다.

```text
AI 응답:      보드 실행 [[fact:T0001]]
working draft: 보드 실행 [[fact:T0001|5/8 PASS]]
clean report:  보드 실행 5/8 PASS
```

확장은 문자열 치환이며 LLM을 호출하지 않는다. 알려지지 않은 reference와 문법이 깨진 reference는 그대로 남겨 기존 `parseAnnotatedDraft()`가 `malformed_fact_marker`로 차단하게 한다. full marker를 직접 출력한 기존 테스트·수동 산출물은 그대로 validator가 처리한다.

### 3.3 산출물 호환성

- `draft.ai.annotated.md`: Claude의 원본 응답을 그대로 보존하므로 bare reference가 들어갈 수 있다.
- `draft.working.annotated.md`: 결정적 확장 후의 기존 full marker 형식만 저장한다.
- `validation.NNN.json`, `report.clean.md`, canonical report, revalidate/update 계약은 변경하지 않는다.
- `prompt-input.json`에는 `factInputMode: "inline_refs"`를 기록해 생성 계약을 식별한다.

## 4. 실패 정책

- catalog 위치의 원문이 catalog `raw`와 다르면 AI 호출 전에 `FACT_SOURCE_MISMATCH`로 실패한다.
- source fact span이 겹치면 AI 호출 전에 `FACT_SOURCE_OVERLAP`으로 실패한다.
- unknown/malformed bare reference는 확장하지 않고 validator가 차단한다.
- 모델이 reference 옆에 `개`, `건`, `회`, 물리 단위, PASS/FAIL 등을 덧붙이면 확장 후 기존 partial-marker 검사가 `unmarked_protected_fact`로 차단한다.
- 모델이 reference를 지우고 숫자를 만들면 기존 unmarked fact 검사가 차단한다.
- 모델이 사실이 든 문장과 reference를 함께 생략하는 것은 기존 계약과 동일하게 허용한다.

## 5. 프롬프트와 비용

full marker를 원문에 직접 삽입하는 보수적 계산에서도 파일럿 입력은 88,836자에서 약 61,142자로 27,694자(31.17%) 감소한다. bare reference는 surface를 반복하지 않으므로 이 상한보다 크지 않아야 한다. 이 수치는 토큰 절감 근거이며 모델 준수율 개선의 인과 증명으로 사용하지 않는다.

## 6. 테스트 및 출시 게이트

1. source annotation과 reference expansion을 순수 함수 단위테스트로 검증한다.
2. 중복 surface가 서로 다른 ID로 유지되는지 검증한다.
3. source mismatch/overlap/unknown reference가 fail-closed하는지 검증한다.
4. generate 통합 테스트에서 raw AI artifact는 bare reference, working artifact는 full marker, canonical report는 clean surface인지 검증한다.
5. prompt가 sourceExcerpt catalog를 중복하지 않고 system reference를 포함하는지 검증한다.
6. 전체 `node --test lib/__tests__/*.test.js` 통과 후에만 실제 Claude 파일럿을 별도 승인 대상으로 올린다. 루트 `node --test`는 실행 스크립트까지 자동 발견하므로 전체 테스트 명령으로 사용하지 않는다.

## 7. 제외 범위

- validator 완화 또는 자동 승인
- validation 실패 후 LLM 재시도
- 사후 문맥 추론으로 모호한 숫자에 fact ID를 자동 배정
- 기존 실패 run의 immutable AI draft 재작성
- 실제 Claude 호출, Redmine 게시, 원격 push

## 8. 구현 검증 증거

- 측정일: 2026-08-28
- sealed snapshot: meeting date `2026-08-26`, content hash `676dd2e0083bf8fb50057c06d71cf4101344b7cf0aa13064af49f4854e82b35c`
- 보호 사실: 377개
- 기존 full-catalog prompt: 88,836자
- inline-reference prompt: 59,844자
- 감소: 28,992자(32.64%)
- 새 prompt marker 구성: bare reference 378회(회의일 reference가 규칙과 system 목록에 각각 등장), full marker 0회
- 측정은 prompt를 로컬에서 결정적으로 재구성했으며 Claude를 호출하지 않았다.
