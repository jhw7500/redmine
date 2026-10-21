# Team Report Audience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 팀 독자용 작성 기준을 주간 회의용 요약과 검토본에 반영.

**Architecture:** 회의용 freeform summary에만 명시적인 team audience를 설정. 같은 sealed snapshot에서 프로젝트 루트 단위의 source coverage와 짧은 전용 prompt를 만들고, 기존 사실·상태·출처 검증 및 immutable 증거를 유지. 상세 source-selection·Slack·게시 복구 및 fallback 정책은 기존 동작 유지.

**Tech Stack:** Node.js, node:test, JSON 설정, 기존 Codex CLI.

**Spec:** `docs/superpowers/specs/2026-10-21-team-report-audience.md`

## Global Constraints

- 기존 cron 실패 수정과 산출물 보존. 초기 범위는 로컬 검증이며, 후속 사용자 '진행'에 따라 자동 수치 보존과 커밋·PR 준비까지 수행. 승인된 게시본의 추가 갱신·Slack 전송 없음.
- 신규 의존성 없음. 서버 작업·빌드 작업 없음.
- 기존 detail generation·legacy summary의 coverage 계약 유지.
- 입력 상한 100000자와 summary당 한 번 생성 정책 유지.
- 코드 변경 후 전체 테스트의 실행·통과·실패·skip 수 확인.

## Review Focus

- 같은 프로젝트의 여러 S/W category가 중복 루트로 변하는 경우: 루트 하나와 원본 위치를 유지.
- 다른 프로젝트의 Notion 또는 숫자 marker를 옮기는 경우: 기존 mismatch 검증 유지.
- 설정이 비활성인 과거 pair: 기존 보고서·증거·게시 선택 호환성 유지.
- 요약이 코드 경로·긴 식별자·여러 문장을 포함하는 경우: team summary 품질 검사에서 차단.
- 팀 전용 설정이 prepare에서만 살아 있는 경우: auto 게시의 증거 확인과 품질 재검사까지 같은 설정 전달.

## Task 1: Project-root coverage and summary integration

**Files:** `lib/source-coverage.js`, `index.js`, `lib/weekly-report-pair.js`, `lib/__tests__/source-coverage.test.js`, `lib/__tests__/weekly-report-pair.test.js`.

**Interfaces:** `buildSourceCoverageCatalog(snapshot, categories, {projectOnly=false})`는 기존 schema와 hash payload로 catalog 반환. summary config가 team audience를 생성·선택 양쪽에 전달.

- [x] 같은 프로젝트의 두 category가 루트 하나로 모이고 Notion 소속이 루트에 유지되는 테스트 추가. 다른 프로젝트로 이동 시 mismatch 확인.
- [x] 실제 prepare·auto publish 계약에서 프로젝트형 summary가 ready가 되는 테스트 추가. 외부 wiki 경계만 메모리 fake 사용.
- [x] 테스트 실패 확인 후 optional scope 및 summary 설정 구현.
- [x] 관련 테스트 실행 및 결과 확인.

## Task 2: Team prompt, quality, and configuration

**Files:** `lib/publisher.js`, `lib/summary-quality-gate.js`, `lib/config.js`, `repo-config.json`, `lib/__tests__/team-report.test.js`, `docs/ai-generation-usage.md`.

**Interfaces:** team audience는 compact prompt를 선택. 설정 `reportFilter.teamReport`를 소비하고 quality 검사는 team audience일 때만 추가 제한 적용.

- [x] 한 줄 한 항목·명사형·식별자 차단·ETC 밑줄 허용·highlight 상한을 검증하는 행동 테스트 추가.
- [x] 실패 확인 후 prompt와 quality 구현. 문구 자체를 복제하는 테스트는 추가하지 않음.
- [x] 독자·분류·들여쓰기·ETC·밑줄 기준을 JSON 설정과 문서에 반영.
- [x] 실제 snapshot의 team prompt가 입력 상한 안에 드는지 확인.

## Task 3: Review draft and verification

- [x] 검토본을 가변 들여쓰기로 재구성하고 빌드 서버 핵심 성과도 근거 범위 안에서 강조.
- [x] 전체 테스트와 diff check 실행. 독립 코드 리뷰 후 필요한 수정만 검증.
- [x] 원본 snapshot을 재사용해 별도 output root에서 실제 provider로 새 pair 생성. 원본 산출물 삭제 및 원격 알림 없음.
- [x] ready summary와 품질·사실 검증, 원본 증거 보존 확인.
- [x] 변경 파일, 다음 cron 영향, 실제 검증 수와 게시 여부 보고.

## Execution Notes

- 사용자 ‘진행’ 승인과 상위 자율 실행 지침에 따라 이 세션에서 직접 구현. 계획 재승인·자동 커밋 없음.
- 기존 원문 fallback 정책은 변경하지 않음. 회의용 요약 실패 시 상세본이 선택될 수 있음을 최종 보고.
- 독립 리뷰 두 지적 수정: 구현 식별자·서술형 검사의 누락 재현과 생성 당시 profile 보존. profile 없는 과거 summary는 legacy로 처리하며 현재 설정 변경 때문에 depth2로 대체하지 않음. 관련 회귀 포함 전체 1139/1139, 실패·skip 0 확인.
- 실제 pair `out/recovery-2026-10-21-team-orvddz7v`: 상세 두 개 검증 성공, 최초 summary는 수치 대상 변경으로 차단. 기존 산출물은 보존.
- 명시적으로 보강한 설정으로 별도 preview `out/recovery-2026-10-21-team-preview-_599o2hr`: 프로젝트별 응답의 사실 오류 0, runtime·문구·과거 backlog의 상태 단어에 대한 pickaxe 경고와 과다 강조 확인. 해당 결과 게시하지 않음.
- 최종 보강은 대표 업무 분량·프로젝트별 강조 선정·현재 이슈와 운영 동작 용어 구분. `out/recovery-2026-10-21-team-final-bwhg8pk7`는 응답 전 CLI exit 1, 응답 산출물 없음. 로그인 상태와 디스크 정상 확인 후 stderr를 private 파일에 보존하는 래퍼로 같은 provider·설정을 별도 실행.
- `out/recovery-2026-10-21-team-verified-r9nzjv5j`의 실제 응답은 fact 오류 0이나 보고서 지침 문구를 미완료로 오인한 경고와 내부 용어가 남아 편집 필요. 합의된 검토본으로 **working draft만** 편집하고 기존 `runRevalidate`와 `runWeeklyPrepare`의 증거 확인으로 READY 복구. AI 원본·prompt·catalog·snapshot·기존 validation 등 9개 증거 hash 불변 확인. 수치의 정확한 원문 대상 표현이 게시 독자 기준과 충돌하는 세부는 근거와 수치 포함 검토본에 보존하고, 검증된 본문에는 정성적 결과로 정리.
- 최종 산출물 `out/recovery-2026-10-21-team-verified-r9nzjv5j/report-2026-10-21.team.md`: READY, validation revision 2 publishable, fact 오류 0, style blocking 0, 밑줄 5. 경고는 선별 제외한 Notion 항목의 source marker 누락만 존재. 자동 생성 원문이 편집 없이 통과했다고 주장하지 않음.
- 최신 전체 테스트 `/tmp/redmine-team-report-final2.tap`: tests 1139, pass 1139, fail 0, skipped 0, cancelled 0. 변경 JavaScript 9개 구문·JSON 파싱·diff check 통과. Redmine·Slack 쓰기 및 커밋·PR 없음.
- 추가 사용자 피드백 반영: 실제 릴리즈 버전·측정/단축 시간·용량·온도 등 성과 수치는 보존. team prompt의 수치 일괄 생략 유도 문구와 기존 feature 간결화 지침을 수정하고, 제품 버전·시간·온도·전력·용량이 style 검사에서 허용되는지 확인.
- 수치 복원 검토본 `out/recovery-2026-10-21-team-verified-r9nzjv5j/report-2026-10-21.team-numeric-review.md`: PIM 접수→동작 시작 10→5.2초와 별도 정지 구간 17초/35초→9.6~9.8초, 실제 릴리즈 0.6.3+jhw.camera16, WLAN 0.7.1 장비 설치와 0.7.2 패키지 제작, 빌드 서버 단기 최고 온도 93°C→78°C 및 조치 후 20분 관찰을 복원. 근거 없는 용량이나 새 계산값은 추가하지 않음.
- 수치 복원본은 별도 editorial review로 보존: source fact 7개 묶음·숫자 표기 13개와 적용 단계를 대조하고 style blocking 0·밑줄 5개 확인. 기존 COMPLETE run과 READY 보고서·검증 증거 12개 hash 불변. 수치 복원본을 기존 READY 검증을 통과한 보고서로 표시하지 않으며, 정식 게시 증거 재생성은 아직 수행하지 않음.
- 이번 수정 후 전체 테스트 `/tmp/redmine-team-numbers-full.tap`: tests 1139, pass 1139, fail 0, skipped 0, cancelled 0. JavaScript 구문·JSON 파싱·diff check 통과. 생성 지침 변경은 다음 cron에 적용되며 cron 일정은 변경하지 않음. Redmine·Slack 게시 없음.
- 사용자 '최종 점검하고 게시까지' 명시 승인 후 수치 복원본의 최종 내용 리뷰 완료. source claim 7개 묶음·숫자 표기 13개, 프로젝트 귀속·측정 조건·적용 단계·밑줄 5개·형식 검사와 fresh 전체 테스트 1139/1139(실패·skip·cancelled 0) 확인.
- 2026-10-21 회의 페이지의 비어 있던 조현우 섹션에 수치 복원본을 게시. 기존 자동 생성 READY proof를 차용하거나 조작하지 않고 `publisher.update`의 수동 승인·version 충돌 보호·최종 문자열 재검증 경로를 사용. 사용자 승인 footer 기록, 실제 서버 version 14→15 및 게시 후 두 차례 GET의 정확한 섹션 일치와 다른 팀원 내용 보존 확인. 원본 생성 증거 12개 hash 불변.
- 게시 증거: `out/recovery-2026-10-21-team-verified-r9nzjv5j/manual-publication-_v3_0_0s/publication.json`. 원격 전후 페이지·게시 문자열·최종 검토 hash·수동 게시 출처를 별도 private 산출물로 보존. Slack 전송·발표노트 이슈 생성·커밋·PR 없음.

## 자동 생성 수치 보존 후속 작업

- 재현: 게시된 수치 검토본을 기존 Q/V로 표시하면 `fact_subject_mismatch` 8건. 대상에 원문 앞부분 전체와 이전 수치가 포함되고, 단위 뒤 조사가 붙을 때 추출 문법도 달라지는 구조적 충돌 확인.
- 구현: 새 팀 catalog에 whole evidence M을 추가하고, 원문 중첩 annotation 소유권·raw/display 재현·자식 facts 순서/범위/프로젝트를 검증. AI는 ID만 선택하며 renderer가 고정 구절을 삽입. 실제 릴리즈 suffix도 원자적 근거로 유지.
- 검증: scalar 검증 완화 없이 대상·조건·단위·비교 관계 변조, 접두/접미, 중복, 프로젝트 이동, 수치 전부 누락, 변조된 catalog를 실패 테스트로 고정. 첫 실행 11개 중 기존 호환 1개 통과·새 동작 10개 실패 확인.
- 완료: whole evidence·실제 릴리즈 suffix·독립 불릿·변조/중복/프로젝트 이동/수치 전부 누락 차단과 canonical raw source 검증. 기존 Q/V 검증은 완화하지 않음. 실측 구절의 용어 사전과 릴리즈 중립 라벨을 포함한 새 계약 독립 리뷰 승인.
- 실제 생성 중 발견한 코드식 명칭·내부 프로필명은 팀 품질 검사에서 차단하고 업무 표현을 안내. 설치와 제작을 모두 보고하면 각각의 실제 버전을 표시하며, 과거 실패 측정값을 현재 성과 아래에 붙이지 않도록 안내. 전체 릴리즈를 강제 수록하는 계약은 추가하지 않음.
- `out/recovery-2026-10-21-auto-final-4rbta3ew`의 실제 Codex 프로젝트 응답 3개를 보존. 최초 validation은 런타임 검사 유예를 미완료로 오인해 차단. 명사형 동작 설명 예외를 고치고 실제 예정·병존 미완료 보호 회귀를 확인한 뒤, **AI 응답과 working draft 변경 없이** 공식 `runRevalidate` 및 `runWeeklyPrepare` 증거 검사로 validation revision 2·READY 확인. 과거 실패 산출물도 유지.
- 실제 수치 근거 5개: PIM 10→5.2초, 정지 시간 17초/35초→9.6~9.8초, 0.6.3+jhw.camera16, WLAN 0.7.1 설치, 빌드 서버 같은 부하대 분당 스로틀 153회→1회·최고 93°C→78°C. 사실 오류 0·형식 차단 0·밑줄 6개. 원본 응답 3개 hash와 이전 산출물 27개 hash 불변 확인.
- 최종 전체 검증: `node --test lib/__tests__/*.test.js`, tests 1168 / pass 1168 / fail 0 / skipped 0 / cancelled 0. 추가된 실패 회귀를 확인한 뒤 통과시켰으며 JavaScript 구문·JSON 파싱·diff check 통과.
- 남은 한계: 대표 업무 선별이므로 이번 자동 결과는 WLAN 0.7.2 제작을 선택하지 않았으며, 71개 불릿은 권장 60개 초과 advisory. 값·조건 보존 검사가 자유롭게 작성한 상위 설명의 의미와 모든 적용 단계를 보증하지는 않음. 기존 요약 실패 시 depth2 대체 정책 유지. 이미 게시한 수치 검토본과 서버 version 15는 이번 검증에서 변경하지 않음.

## PR 심사 수정: review-fix round 1

- A-R1-001: 릴리즈의 제작·설치·고객 전달 단계와 상태를 같은 버전이 포함된 닫힌 원문 절에 결속. 원문 위치·문구를 catalog에 보존하고 검증 때 재현. 알 수 없는 상태·취소·서로 다른 상태 변화로 완료를 만들지 않음.
- 버전 불릿의 상위 단계 설명도 검사. 같은 부모의 평면 배치는 바로 인접한 단계와 단일 버전을 일대일로 연결할 수 있을 때만 허용하며, 멀리 떨어진 근거나 다중 버전 wrapper의 암묵적 연결은 차단. 이 오류는 override로 우회 불가.
- A-R1-002: ‘전까지 + 방지’만으로 실제 개발 작업의 보류가 검증에서 빠지던 예외를 제거. 재기동 직후 첫 조각 전 파일 검사와 재연결 시 알림 전송이라는 명시적 런타임 동작만 예외로 유지. 실제 릴리즈 작업 보류는 기준일 정규화와 Git 이력 확인까지 수행.
- 회귀 검증: `node --test lib/__tests__/team-evidence.test.js lib/__tests__/open-status-context.test.js`, tests 79 / pass 79 / fail 0 / skipped 0 / cancelled 0. 원본 심사 반례와 상태 전이·취소·비인접·다중 버전 연결의 실패를 확인한 뒤 수정.
- 최종 전체 검증 1회: `node --test lib/__tests__/*.test.js`, tests 1178 / pass 1178 / fail 0 / skipped 0 / cancelled 0. 변경 JavaScript 7개 구문 및 diff 공백 검사 통과.
- 검사는 명시된 제작·설치·고객 전달 표현의 단계·상태와 연결 관계를 대상으로 함. 자유 서술 전체의 의미를 증명하지 않으며, 복합 문맥은 중립적인 버전 표기 또는 수동 내용 검토가 필요.
- 기존 AI 응답·snapshot·READY/게시 증거는 수정하지 않았고 유료 AI 호출·서버 쓰기·Slack 발송 없음. 생성·검증 보강은 다음 cron 준비부터 적용되며 cron 일정·래퍼·환경 파일은 변경하지 않음.

## PR 심사 수정: review-fix round 2

- A-R2-001: 단계 단어 앞의 접두 부정과 단어 경계를 확인해 ‘미제작·미설치·미납품 확인’을 완료 근거로 취득하지 않음. 장비 미적용·미배포·고객 미전달도 불명확한 단계로 차단.
- 단계어 바로 앞의 단일 부정 토큰에만 강조·inline code·괄호·따옴표 처리를 적용. 임의 마크업 전체를 제거하지 않으므로 양성 예제 전체의 인용·강조가 새로운 완료 근거가 되지 않음. ‘미설치 현황’처럼 후행 메타 표현으로 부정 단계가 검사에서 사라지는 경우도 차단.
- 제작·설치·전달 각각의 긍정 원문→부정 출력과 부정 원문→긍정 출력은 전체 report contract에서 우회 불가능한 실패. 부정 원문에 대한 중립 버전 표기와 정상 ‘미디어 패키지 제작 확인’은 유지. 변경은 원문 증거와 위치를 재작성하지 않음.
- 실패 회귀 확인 후 수정. `node --test lib/__tests__/team-evidence.test.js`: tests 30 / pass 30 / fail 0 / skipped 0 / cancelled 0. `node --test lib/__tests__/team-evidence.test.js lib/__tests__/open-status-context.test.js lib/__tests__/team-report.test.js`: tests 90 / pass 90 / fail 0 / skipped 0 / cancelled 0. 좁은 독립 코드 검토 승인.
- 최종 전체 검증 1회: `node --test lib/__tests__/*.test.js`, tests 1182 / pass 1182 / fail 0 / skipped 0 / cancelled 0. 심사 수정 JavaScript 7개 구문 및 diff 공백 검사 통과.
- 기존 AI 응답·snapshot·READY/게시 증거 유지. 서버 쓰기·Slack 발송·유료 AI 호출·빌드 실행 없음. 다음 cron의 검증에 적용되며 일정·래퍼·환경 파일은 변경하지 않음.

## 심사 실패 후 로컬 수정: 부정 구분자 공통 처리

- 사용자 ‘진행해’에 따라 수정·회귀·전체 검증까지만 수행. 기존 3차 Tribunal FAIL 기록은 보존하며 새 정식 심사·커밋·push·PR 생성은 수행하지 않음.
- A-R3-001: `미-설치 확인`의 부정이 문장 분할에서 사라지는 경로를 수정. 표기별 마크업 제거 예외를 공통 단어 순회로 대체하고, 부정 토큰과 동작 사이의 공백·구두점·기호·서식 문자 및 대상어를 함께 읽음. 원문 구절과 위치는 재작성하지 않음.
- 추가 코드 검토에서 발견한 `장비미적용·보드미배포·고객미전달`도 기존 단계 문법의 대상어를 재사용해 같은 순회에서 차단. 공백 없는 긍정 문구와 `미디어·이미·도우미·국비`는 완료 근거 유지. 해당 지적에 대한 좁은 재확인에서 잔여 문제 없음 확인; 정식 Tribunal 재심사를 대체하지 않음.
- 회귀는 제작·설치·전달의 긍정 원문→부정 출력, 부정 원문→긍정 출력 차단과 중립 버전 유지, 구분자·대상어·HTML 엔티티·Markdown 표현, 서로 다른 버전의 원문 절 분리까지 전체 보고서 계약에서 확인. 추가 qualifier 회귀의 수정 전 결과는 tests 39 / pass 38 / fail 1, 수정 후 집중 검증은 tests 99 / pass 99 / fail 0 / skipped 0 / cancelled 0.
- 최종 전체 검증 1회: `node --test lib/__tests__/*.test.js`, tests 1191 / pass 1191 / fail 0 / skipped 0 / cancelled 0. JavaScript 구문 검사와 diff 공백 검사 통과. 실행 원문·결과·입력 hash는 `/tmp/redmine-common-negation-evidence-vqgdptr4`에 private 파일로 보존.
- 한계: `장비 안 케이블 설치 완료`의 장소 명사 `안`처럼 부정과 구별하기 어려운 문맥은 보수적으로 완료 근거에서 제외. 중립 버전 표기는 허용하며 의미가 명확한 원문 근거가 필요하다는 운용 지침과 회귀를 추가.
- 기존 Tribunal verdict와 이미 게시한 수치 검토본의 hash 불변 확인. 기존 생성·게시 증거, Redmine version 15 및 Slack 발송 보류 유지. 생성·검증 경로 변경은 다음 cron 실행부터 적용되며 일정·래퍼·환경 파일은 변경하지 않음.

## 후속 심사 수정: 단계 앞뒤의 상태 대조

- 새 1차 심사 A-R1-001은 `미완료 패키지 제작 확인`처럼 앞의 비완료 상태가 뒤의 확인으로 승격되는 실제 계약 누락. 사용자 ‘잘좀해봐 별거아니면 그냥 넘어가도됨’에 따라 이 오류를 수정하고 경미한 스타일·명명 문제는 추가 수정 대상으로 삼지 않음.
- 기존 상태 사전을 접두·접미 판정이 공유하도록 모으고, 문장 분할 전 단어 순회에서 단계 앞 상태를 결속. 서로 같은 상태는 보존하고 다른 상태·알 수 없는 상태는 단계 근거에서 제외. 별도 표기 예외나 의존성·환경·권한·엔드포인트를 추가하지 않음.
- 제작·설치·전달 각각에서 기존 9개 비완료 상태와 구분자·강조·붙여쓰기의 양방향 변조 실패, 중립 버전 유지, 앞뒤 일치·충돌을 회귀로 추가. 수정 전 릴리즈 회귀 tests 43 / pass 39 / fail 4, 수정 후 집중 tests 103 / pass 103 / fail 0 / skipped 0 / cancelled 0.
- 직전 B의 6개 미확인은 컨트롤러가 ‘pipeline 실행 금지’를 넓게 전달한 영향. 외부 호출 없는 순수 함수·fixture·fake provider/HTTP 기반 통합 테스트는 허용하고, 실제 provider·환경 래퍼·Redmine·Slack 호출만 금지하는 경계로 바로잡음. 기존 심사 응답과 판정은 수정하지 않음.
- 좁은 코드 점검에서 발견한 일반 명사 오탐도 수정. 상태어 전체와 닫힌 연결어·대상어 문법으로 제한하고 `계획서·취소선·중단점·실패율·함께`의 정상 완료 근거 보존을 전체 계약 회귀로 확인. 수정 전 tests 44 / pass 43 / fail 1, 수정 후 집중 tests 104 / pass 104 / fail 0 / skipped 0 / cancelled 0.
- 앞서 지적된 일반 명사 오탐과 기존 상태·부정 보호의 좁은 재확인에서 잔여 문제 없음 확인. 스타일·명명이나 추측성 언어 사례로 범위를 넓히지 않음.
- 최종 전체 검증 1회: `node --test lib/__tests__/*.test.js`, tests 1196 / pass 1196 / fail 0 / skipped 0 / cancelled 0, 16.977초. 외부 호출 없는 fixture·fake 기반 통합 테스트도 포함. 변경 JavaScript 2개 구문 검사와 diff 공백 검사 통과. 실행 원문과 입력 hash는 `/tmp/redmine-stage-state-fix-2em1tubw`에 private 파일로 보존.
- 기존 Tribunal verdict와 게시된 수치 검토본 hash 불변 확인. 기존 AI/READY/게시 증거, Redmine version 15 및 Slack 발송 보류 유지. 다음 cron부터 상태 검증에 적용되며 일정·래퍼·환경 파일은 변경하지 않음.
