# 원천 날짜 꼬리·백슬래시 오탐 보완 검증 (#143)

## 변경과 fail-closed 경계

파일·경로 날짜의 꼬리는 같은 catalog fact의 원천 위치·선택된 ISO 날짜·전체 파일 토큰이 일치할 때만 예외로 삼는다. 원천에 없는 꼬리, 다른 경로·확장자, 다른 fact에서 빌린 참조는 거부한다. `date [[fact:V0001|2026-05-08]] ms`와 독립된 표식 밖 측정값도 계속 실패한다.

AI 입력 사본은 삽입 표식 바로 앞의 마지막 ASCII 역슬래시만 U+2216(∖)으로 바꾼다. 현재 파서는 run의 홀짝을 구분하지 않으므로 홀수·짝수 run 모두 처리한다. 원천·catalog·오프셋·snapshot 해시, 출력 파서·공용 추출기 및 지정된 기존 보호 테스트의 기대값은 유지한다. AI 호출 전 차단형 왕복 검사는 추가하지 않는다.

최종 복원은 AI 응답 이후에만 판단한다. 실제 annotation owner·raw·위치·행·열·excerpt를 확인한 뒤, 기존 annotate → expand → parse로 만든 비교용 원천 투영과 출력 줄의 전체 본문·fact ID·상대 구간을 대조한다. 이 투영은 M.display를 포함하고 저장된 annotated bytes/hash를 바꾸지 않는다. 같은 본문이 다른 원천 줄의 genuine U+2216으로도 설명되면 ID와 무관하게 모호한 것으로 처리한다. 불명확한 후보는 기호를 보존하면서 `fact_evidence_mismatch`로 차단하며 validation override로 우회할 수 없다.

들여쓰기·선두 bullet 하나·전체 본문을 감싼 underline 한 겹만 비교용으로 허용한다. 내부 공백·구두점·slash run·Unicode는 정규화하지 않는다. 확정된 문자만 의미 대조·최종 clean 출력에서 복원하고 기존 run-clean/canonical/게시 경로가 그 문자열의 hash를 고정한다.

## 심사 지적과 근거 범위

- `A-R1-001`: 입력용 기호가 최종 경로·명령에 남는 문제를 최종 clean 복원과 hash·모의 게시 회귀로 보완했다.
- `B-R1-001`: 같은 경로의 여러 치환을 각 원천 token offset과 연결한다. 다른 fact 차용·표식 없는 치환·꼬리 변조는 거부한다.
- `A-R2-001`: 같은 marker를 다른 genuine U+2216 문맥으로 옮기거나, 동일 본문의 ASCII/Unicode 원천이 공존하는 경우를 차단한다. 반복 ID도 출력 줄마다 판단한다. 전체 줄 highlight·continuation의 정상 복원과 실패 시 canonical 승격·게시 차단을 검증한다.
- `B-R2-C016`의 과거 전송 계측은 controller 관찰 기록으로 보존한다. 허용된 application 파일만으로 과거 네트워크 횟수나 서버 변경 이력을 독립 입증하지 못했다. 이 문서의 독립 검증 결론은 현재 fixture 기반 prepare transport 경계와 저장된 산출물의 계약·hash 정합성에 한정한다.

`fixture pair preparation does not invoke fetch or http transports`는 임시 snapshot과 fake AI를 사용해 실제 `prepareWeeklyPair`를 실행한다. fetch·http.request·https.request에 fail-fast spy를 두고 두 depth가 ready가 되는 동안 해당 transport가 호출되지 않으며 게시·Slack delivery 영수증이 생성되지 않음을 검사한다. 이는 현재 코드 경계의 실행 proxy이며 과거 실제 리허설의 전송 이력을 소급 측정하는 검사는 아니다.

## 테스트와 보존 snapshot 재생

- `node --test lib/__tests__/*.test.js`: 실행 1,270 / 통과 1,270 / 실패 0 / 건너뜀 0.
- 대상 파일은 `fact-references.test.js`, `fact-contract-validator.test.js`, `report-generate-v2.test.js`이며 이동 문맥·Unicode 충돌·반복 ID·override 거부·highlight·prepare transport의 회귀를 포함한다.
- 운영 `out/pairs/*/source/snapshot.json` 전체의 catalog → annotate → expand → parse 재생: 보존 snapshot 6개 성공, 파서 오류 없음, 파일 바이트와 catalog JSON 유지. 원천 annotation 함수는 이 문맥 보완에서 변경하지 않았다.
- 보호 테스트의 기존 부분과 파서·공용 추출기가 유지됐음을 diff와 전체 테스트로 확인했다. 잘못된 annotation을 기대하던 생성 assertion만 최초 수정에서 보완했으며 AI 호출 assertion은 유지했다.

비추적 `out/artifacts/2026-11-05-issue-143/`의 `source-replay.json`, `r3-full-suite.log`에 재생 목록·hash와 실행 로그를 보존했다.

## 2026-11-11 회의일 리허설

C1 재현 당시 sealed snapshot을 고정 재사용했다. 새 기간 전체를 다시 수집한 결과는 아니다.

- snapshot content hash: `a410d874f653742ca5159a24b71540cf636c35888105cb22770ee8cdde56498c`
- 입력 파일 SHA-256: `38e197cb301122d9a3dc345ebcda29f3a7e9d794464bddac3f16f3ded76d30d7`
- 회의일 `2026-11-11`; 임시 출력 `/tmp/redmine-143-rehearsal-1ZxRKi`.
- profile: Codex `gpt-5.6-sol` / low, source_selection / whole, fallback 허용, validation block / override false, presentation suggest.

| Variant | State | Contract | Origin |
|---|---|---|---|
| depth2 | ready | PASS | ai |
| depth3 | ready | PASS | ai |
| summary | ready | PASS | freeform/project |

`readWeeklyPair`로 depth2·depth3 READY 근거와 최신 validation hash를 확인했다. summary도 quality gate를 통과했다. 원본 snapshot 파일은 유지됐다. application 산출물은 같은 공용 계약으로 AI 재호출 없이 독립 재검증할 수 있다.

실행 recipe는 `prepareWeeklyPair(config, date, {collect})`에 원본 snapshot 복사 collector를 주입하는 준비 경로다. 실제 전송 이력에 대한 controller 계측과 독립 산출물 검증은 위 근거 범위에 따라 구분한다. `APP_OUT`은 운영 체크아웃의 `out`, `TASK_WORKTREE`는 작업 브랜치의 체크아웃 경로이며 다음 명령은 Codex 호출 비용이 발생한다.

```bash
node "$APP_OUT/artifacts/2026-11-05-issue-143/r3-rehearsal/rehearsal.cjs" "$TASK_WORKTREE" \
  "$APP_OUT/artifacts/2026-11-04-rehearsal-1111-v2/redmine-rehearsal2-1111.wksv03/pairs/2026-11-11/source/snapshot.json"
```

`r3-rehearsal/`의 실행 metadata·로그·`output.tar.gz`에 application 출력을 보존했다. 검증 상태·hash는 generation의 `latestValidationPath`를 기준으로 확인한다.

## 호환성과 반영 조건

이 검증은 독립 브랜치의 scan contract 31 snapshot을 사용했다. #140의 contract 32를 함께 반영할 때는 원천을 새로 수집하고 pair/run을 다시 준비한다. annotation·문맥 복원 이전의 annotated/clean hash를 현재 코드의 근거로 재사용하거나 과거 snapshot을 새 계약으로 재봉인하지 않는다. 문맥을 다시 쓴 자유 서술의 역슬래시는 보수적으로 차단될 수 있다.

반영 후 정기 cron은 새 annotation/validator를 사용한다. 머지·운영 반영·서버 쓰기는 사용자 승인 후 진행하며 운영 반영은 2026-11-11 07:05 KST 이후, 수요일 06:05~07:05 KST 밖에서 수행한다.
