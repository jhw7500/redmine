# 원천 날짜 꼬리·백슬래시 오탐 보완 검증 (#143)

## 변경과 fail-closed 경계

파일·경로 날짜의 꼬리는 같은 catalog fact의 원천 위치·선택된 ISO 날짜·전체 파일 토큰이 일치할 때만 예외로 삼는다. 원천에 없는 꼬리, 다른 경로·확장자, 다른 fact에서 빌린 참조는 거부한다. `date [[fact:V0001|2026-05-08]] ms`와 독립된 표식 밖 측정값도 계속 실패한다.

AI 입력 사본은 삽입 표식 바로 앞의 마지막 ASCII 역슬래시만 U+2216(∖)으로 바꾼다. 안전한 사본을 파싱한 뒤 catalog owner·원천 raw·위치·행·열·excerpt에서 ASCII 역슬래시를 확인한 claim의 문자만 의미 대조와 최종 clean 출력에서 복원한다. annotated bytes/hash는 그대로이며 진짜 U+2216은 전역 치환하지 않는다. 같은 파일 안의 모든 치환은 그 토큰의 원천 offset까지 대조한다. 현재 파서는 run의 홀짝을 구분하지 않으므로 홀수·짝수 run 모두 처리한다. 원천·catalog·오프셋·snapshot 해시는 유지하며, 출력 파서·공용 `extractSchemaV2FactOccurrences`와 보호 대상으로 지정된 기존 테스트의 기대값은 변경하지 않았다. AI 호출 전 차단형 왕복 검사도 추가하지 않았다.

## 심사 지적 반영

- `A-R1-001`: 경로·명령의 최종 clean 바이트를 원래 역슬래시로 복원하고 run-clean/canonical/validation 해시가 같은 문자열에 고정되게 했다.
- `B-R1-001`: 버전·날짜 앞에 여러 치환이 있는 경로를 허용하면서 다른 파일에서 빌린 참조·표식 없는 치환·꼬리 변조는 거부한다.
- 추가 회귀는 source copy의 바이트 보존, genuine U+2216, 실패 draft 수정 후 재검증, source-selection 모의 게시를 확인한다. 완료 run의 재검증 금지도 유지한다. 대상 스위트는 실행·통과 119, 실패·건너뜀 0이다.

## 전체 테스트와 보존 snapshot 재생

- `node --test lib/__tests__/*.test.js`: 실행 1,264 / 통과 1,264 / 실패 0 / 건너뜀 0.
- 운영 체크아웃의 `out/pairs/*/source/snapshot.json` 전체를 읽기 전용으로 catalog → annotate → expand → parse에 재생했다. 보존된 6개 snapshot 모두 성공했으며 파서 오류는 0이었다. 파일 바이트와 catalog JSON의 불변도 확인했다.
- 보호 테스트 파일의 기존 부분과 파서·공용 추출기가 유지됐음을 diff와 전체 테스트로 확인했다. 생성 회귀 중 잘못된 annotation을 기대하던 assertion만 새 사본에 맞췄으며 AI 호출 assertion은 유지했다.

상세 재생 목록·해시와 테스트 로그는 운영 체크아웃의 비추적 `out/artifacts/2026-11-05-issue-143/` 아래 `source-replay.json`, `review-fix-full-suite.log`에 보존했다.

## 2026-11-11 회의일 리허설

C1이 재현됐던 11-04 리허설의 sealed snapshot을 그대로 재사용했다. 새 기간 전체를 다시 수집한 결과는 아니다.

- snapshot content hash: `a410d874f653742ca5159a24b71540cf636c35888105cb22770ee8cdde56498c`
- 입력 파일 SHA-256: `38e197cb301122d9a3dc345ebcda29f3a7e9d794464bddac3f16f3ded76d30d7`
- 회의일: `2026-11-11`; 임시 출력: `/tmp/redmine-143-rehearsal-uhnkLh`.
- profile: Codex `gpt-5.6-sol` / low, source_selection / whole, fallback 허용, validation block / override false, presentation suggest.

| variant | pair 상태 | fact 검증 | 선택 출처 |
|---|---|---|---|
| depth2 | ready | PASS, issues 없음 | ai (Codex) |
| depth3 | ready | PASS, issues 없음 | deterministic_fallback (SOURCE_SELECTION_INVALID) |
| summary | ready | PASS, quality gate 통과 | freeform/project |

`readWeeklyPair`로 depth2·depth3 READY 근거와 최신 validation 파일 해시를 다시 검증했다. 요약본도 quality gate를 통과했다. depth3는 AI selection 거부 후 허용된 결정적 fallback을 사용했으므로 AI 선택 자체가 성공했다고 해석하지 않는다.

리허설은 `prepareWeeklyPair(config, date, {collect})`에 원본 snapshot 복사만 하는 collector를 주입하고 실제 Codex 생성을 호출했다. `.env`와 수집 API credential은 로드하지 않았다. GitHub evidence는 실제 토큰 없이 기존 계약의 enabled 존재 플래그만 맞췄고, 부모 프로세스의 fetch/http/https 요청을 거부했다. 셸 래퍼·게시·Slack send를 실행하지 않았으며 부모 네트워크 호출은 0이었다. 원본 snapshot 파일 바이트는 그대로다.

실제 실행 명령은 다음과 같다. `APP_OUT`은 운영 체크아웃의 `out`, `TASK_WORKTREE`는 이 이슈 작업 브랜치의 체크아웃 경로다. 이 명령은 Codex를 호출하므로 비용이 발생하며, 저장된 산출물 검증은 재호출 없이 수행할 수 있다.

```bash
node "$APP_OUT/artifacts/2026-11-05-issue-143/review-fix-rehearsal/rehearsal.cjs" "$TASK_WORKTREE" \
  "$APP_OUT/artifacts/2026-11-04-rehearsal-1111-v2/redmine-rehearsal2-1111.wksv03/pairs/2026-11-11/source/snapshot.json"
```

`review-fix-rehearsal/`의 `rehearsal-start.json`, `rehearsal.log`, `rehearsal-result.json`, `output.tar.gz`에 실행 metadata와 임시 application 출력을 보존했다. 실제 검증 상태·해시는 generation의 `latestValidationPath`를 기준으로 확인했다.

## 호환성과 반영 조건

이 검증은 독립 브랜치의 기존 scan contract 31 snapshot으로 수행했다. #140의 scan contract 32를 함께 반영할 때는 원천을 새로 수집하고 pair/run을 다시 준비한다. 백슬래시 annotation과 최종 clean 복원 규칙 이전에 만든 pair/run은 다시 준비한다. 옛 annotated/clean hash를 현재 코드의 근거로 재사용하지 않는다. 검증을 우회하거나 과거 snapshot을 새 계약으로 재봉인하지 않는다.

정기 cron은 반영된 새 annotation/validator를 사용하게 된다. 머지·운영 반영·서버 쓰기는 사용자 승인 후 진행하며 운영 반영은 2026-11-11 07:05 KST 이후, 수요일 06:05~07:05 KST 밖에서 수행한다. 이번 작업에서는 해당 실행을 하지 않았다.
