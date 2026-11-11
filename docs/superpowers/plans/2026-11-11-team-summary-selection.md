# 원문 근거 선택형 팀 요약 구현 계획

목표: AI가 사실 문장을 재작성하지 않고 원문 근거와 구성을 선택하며, 코드가 보호 사실과 조건을 보존해 팀 요약을 렌더링한다.

설계 근거: `2026-11-11-protected-summary-claims-proposal.md`와 사용자의 보호 사실 고정·AI 선택/구성 선택.

## 공통 제약

- Node 18+ 기본 모듈과 기존 유틸리티만 사용한다.
- 기존 스냅샷·catalog·AI 응답·실패 검증·게시 영수증은 변경하지 않는다.
- 새로운 AI 호출은 선택 1회이며 잘못된 응답 뒤 추가 AI 재시도를 하지 않는다.
- 값·단위·부정·대상·조건·결과의 자유 재작성과 무근거 보류 기준일 추가를 허용하지 않는다.
- 새 프로필만 변경한다. 기존 상세 선택본과 v1 팀 freeform 증거는 기존 방식으로 읽는다.
- 서버 쓰기와 Slack 전송은 기존 승인·영수증·원격 대조 경계를 유지한다.

## 1. 원문 근거 컴파일러

소유 파일: `lib/team-summary-selection.js`, `lib/__tests__/team-summary-selection.test.js`.

인터페이스:

```js
buildTeamSummaryRecords(snapshot, factCatalog, coverageCatalog, config)
buildTeamSummaryPrompt(records, config)
parseTeamSummarySelection(text, records, leaderHighlight)
buildTeamSummaryFallbackSelection(records, leaderHighlight)
renderTeamSummarySelection(records, selection, options)
```

- [x] 독립 문장 묶음의 위치·원문·보호 fact/source ID와 표시 행을 `schemaVersion: 2`, `profile: team_summary_v1`, `renderVersion: 1` 레코드로 만든다.
- [x] 준비 완료와 승인 대기 등 종속 조건을 같은 묶음으로 보존하고, 현재 상태 근거 없는 보류 묶음·잘린 근거·기술 상세 덤프는 선택에서 제외한다.
- [x] 기존 M 후보 추출은 독립 측정의 위치를 찾는 용도로 재사용하되 새 선택 경로는 scalar reference로 값과 단위를 보존한다.
- [x] AI 출력은 고정 theme과 원문 ID·highlight만 허용한다. 같은 원문 중복, 프로젝트 이동, 추가 문장 필드를 차단한다.
- [x] 최소 프로젝트당 1묶음, 최대 전체 12묶음·프로젝트당 5묶음으로 제한한다. 사용 가능한 의미 있는 측정·릴리즈를 전부 생략하지 못하게 한다.
- [x] 기본 대체 선택도 같은 파서와 렌더러를 통과한다.
- [x] 조건 삭제·수치 변경·무근거 날짜·중복·교차 프로젝트·기술 상세·불완전 문장 반례와 세 프로젝트 정상 예를 먼저 실패시킨 뒤 구현한다.

## 2. 인증된 표시 문맥

소유 파일: `lib/fact-context-projection.js`, `lib/fact-validator.js`, `lib/__tests__/fact-context-projection.test.js`.

- [x] `createFactContextProjection(content, {catalogHash, sourceRecordsHash, profile})`와 `readFactContextProjection(proof, {content, catalogHash})`를 구현한다.
- [x] 이 객체는 코드 내부에서 원문 레코드 재구성과 정확한 렌더 대조 뒤에만 만든다. JSON 객체나 복사본은 인증으로 취급하지 않는다.
- [x] 올바른 객체가 있을 때만 수치의 원문 설명 접두 어휘 비교를 생략한다. 값·단위·붙임 대상·프로젝트·미표시 사실·판정 검사는 유지한다.
- [x] 객체·catalog·내용 불일치는 `fact_context_projection_mismatch`로 차단한다.
- [x] 기본 호출의 대상 변경 반례는 그대로 실패하고, 인증된 형식 변경만 통과하는 테스트를 작성한다.

## 3. 생성·검증·게시 연결

소유 파일: `index.js`, `lib/source-selection-generation.js`, `lib/source-selection-evidence.js`, `lib/weekly-report-pair.js`, 관련 통합 테스트.

- [x] `generationMethod: source_selection`을 재사용하고 프로필에 따라 builder·prompt·parser·fallback·renderer를 선택한다.
- [x] 새 요약은 프로젝트 루트 coverage와 기존 scalar catalog를 사용한다.
- [x] records·selection·AI 응답·prompt·profile의 소유권과 해시를 생성·재검증·게시 시 모두 확인한다.
- [x] 원문에서 레코드를 재구성하고 선택 렌더와 working draft가 정확히 일치할 때만 판정·수치 표시 projection을 제공한다.
- [x] 새 `summaryQualityProfile` v2에 method·selectionProfile·renderer를 저장한다. 프로필 없음과 v1은 기존 freeform으로 복원한다.
- [x] 원문 선택 실패 요약 우선 게시, 경로·단일 헤더·영수증·실패 상태 보존을 유지한다.
- [x] 새 프로필의 생성·READY·publish proof·변조 거부·legacy 복원·단일 호출을 통합 테스트한다.

## 4. 운영 설정과 완료 증거

- [x] `repo-config.json`의 팀 보고에 `selectionProfile: team_summary_v1`을 명시한다. 키가 없는 기존 설정은 기존 freeform을 유지한다.
- [x] 전체 `node --test lib/__tests__/*.test.js` 실행·통과·실패·skip 수와 구문·diff 검사를 기록한다.
- [x] 저장소 fixture에서 생성·재검증·publish proof의 동일한 근거 결속과 조건 변조 거부를 재현한다.
- [x] 상위 문맥이 불명확한 Git 근거는 제외하고, 측정 뒤의 설명도 전체 묶음에 함께 보존한다.
- [x] 추가 AI 호출 없이 대체 선택을 사용하는 동작을 가짜 provider로 검증한다.

정기 cron에 새 프로필을 적용하는 배포 경계는 이 변경의 main 병합이다.

## 운영 확인 범위

실제 주차 자료·유료 AI 응답·Redmine 게시 이력은 별도 운영 감사 대상이다.
이 문서의 체크리스트는 저장소에서 재현할 코드 완료 기준이며 실제 서버 이력을 증명하지 않는다.
운영 확인에는 해당 주차의 보존된 snapshot·AI 응답·게시 영수증과 원격 조회가 필요하다.
과거 실패 산출물이나 게시 영수증을 변경해 통과로 표시하지 않는다.

## review-fix round 2

- A-R1-001: 독립 측정은 원문 불릿 전체와 정확히 같고 소유 항목에 다른 설명이 없을 때만 허용한다. 나머지는 조건을 포함한 전체 묶음으로 선택하거나 제외한다.
- B-R1-001: Git 근거도 설정으로 확인된 구조용 상위 항목만 생략할 수 있다. 빈 줄 뒤 조건을 포함하고 하위 항목·해석할 수 없는 설명이 있으면 부분 묶음을 만들지 않는다.
