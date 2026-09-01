# 주간보고 원본 커버리지 및 카테고리 결속 설계

- 작성일: 2026-09-01
- 상태: 승인됨(2026-09-01)
- 대상 저장소: `/home/jhw/ai/opencode/projects/redmine`
- 관련 이슈: GitHub #47 `fix(report): 사실 참조 회피로 내용 누락·카테고리 오분류가 PASS되는 회귀 차단`
- 선행 설계: `2026-08-26-report-fact-contract-design.md`, `2026-08-28-inline-fact-reference-design.md`

## 1. 사고 판정

2026-08-26 sealed snapshot을 최신 `main`에서 다시 생성한 파일럿은 validation `PASS`,
`publishable=true`였지만 실제 게시본과 동등하지 않았다.

- snapshot content hash는 양쪽 모두
  `676dd2e0083bf8fb50057c06d71cf4101344b7cf0aa13064af49f4854e82b35c`였다.
- 기존 게시본은 5,380자·91개 불릿, 재생성본은 3,278자·56개 불릿이었다.
- Claude 원출력은 488개 fact가 있는 입력에서 `[[fact:...]]` reference를 하나도 출력하지 않았다.
- 후처리는 `MCP4018`, `iMX93` 두 identifier만 자동 결속했고, 나머지 보호 사실은 문장과 함께
  생략됐으므로 기존 fact validator의 검사 대상이 되지 않았다.
- 원본 `PIM > iMX8MP BSP`가 출력에서 `PIM > iMX93 BSP`로 바뀌었고,
  실제 `Wireless Lan > iMX93 BSP`는 사라졌다.
- 잘못 배치된 `iMX93`은 Wireless Lan 원본의 fact `V0108`에 자동 결속됐지만 현재 validator는
  identifier의 원본 카테고리를 검사하지 않아 통과했다.

따라서 기존 검증기는 **출력된 보호 사실의 정확성**에는 fail-closed하지만,
**보고 대상의 존재와 원본 카테고리**에는 fail-open이다. 이 문제는 프롬프트 문구만 강화해서
해결할 수 없으며, 출력에 남아야 하는 원본 단위와 위치를 결정적 ID로 결속해야 한다.

## 2. 목표

1. 내용이 있는 설정 기반 보고 섹션을 출력에서 정확히 한 번 보존한다.
2. 보고 입력에 포함된 모든 `[Notion]` 항목을 압축·그룹화하더라도 누락하지 않는다.
3. 필수 항목과 identifier를 원본의 canonical 카테고리 밖으로 이동하지 못하게 한다.
4. coverage marker 누락·중복·변조·오배치를 하나의 validation에서 모두 진단한다.
5. 기존 숫자·단위·조수사·PASS/FAIL exact-copy fact 검증을 약화하지 않는다.
6. 실패 시 Claude를 재호출하지 않고 immutable run artifact와 수동 revalidate 흐름을 유지한다.

## 3. 비목표와 보장 한계

- 자연어 요약이 원문과 의미상 완전히 동등한지 NLP로 판정하지 않는다.
- 모든 git commit 또는 모든 보호 fact를 보고서에 강제로 출력하지 않는다.
- 기존 depth별 압축, 테마 그룹화, Wireless Lan 축약 정책을 제거하지 않는다.
- validation 실패 후 자동 LLM 재시도·자동 교정·Redmine 게시 우회를 추가하지 않는다.
- schema v1과 기존 coverage 미적용 schema v2 run을 일괄 변환하지 않는다.

source marker는 항목의 **존재와 소유 카테고리**를 증명한다. marker 주변 문장의 의미 품질은
사람 검토 대상이며, 수치·식별자 정확성은 기존 fact contract가 담당한다.

## 4. 검토한 접근

### 4.1 선택: source coverage marker

필수 섹션과 모든 `[Notion]` 입력 항목에 위치 결속 ID를 부여하고, AI가 요약 문장과 함께 ID를
복사하게 한다. validator는 ID의 완전성·유일성·카테고리를 검사하고 성공 후 marker만 제거한다.

이 방식은 항목을 여러 테마로 묶는 현재 요약 자유도를 유지하면서 누락과 이동을 결정적으로
검출한다.

### 4.2 제외: 보호 fact 사용률 임계치

`사용 fact / 전체 fact` 비율은 내부 ID·빌드 수치처럼 의도적으로 삭제할 사실이 많은 주마다 크게
변한다. 고정 비율은 정상 보고서를 차단하거나, 낮은 임계치로 우회 가능한 계약이 되므로 제외한다.

### 4.3 제외: 프롬프트 강화와 재생성

2026-08-28과 2026-09-01 파일럿에서 모델은 각각 full marker와 bare reference를 전부 생략했다.
확률적 준수에 다시 의존하면 실패 수렴을 보장하지 못하고 Claude 사용량만 늘리므로 제외한다.

## 5. source coverage catalog

새 순수 모듈 `lib/source-coverage.js`가 sealed snapshot과 `repo-config.json`의 `categories`를 받아
결정적 catalog를 만든다.

### 5.1 필수 섹션

`categories[*].templateKey`에 대응하는 `snapshot.autoContent`가 비어 있지 않고
`(변경 없음)`만 포함한 값이 아니면 해당 canonical path를 필수 섹션으로 등록한다.

예:

```json
{
  "id": "C0005",
  "kind": "section",
  "categoryKey": "pimBsp",
  "requiredPath": ["PIM", "iMX8MP BSP"],
  "sourceLocation": {"line": 352, "column": 5},
  "sourceExcerpt": "iMX8MP BSP"
}
```

`etc`처럼 `label: null`인 category는 상위 path `ETC`만 요구한다. 테마 헤더는 AI가 자유롭게 만들 수
있으며 coverage path에 포함하지 않는다.

### 5.2 필수 Notion 항목

렌더링된 `snapshot.rawContent`에서 `- [Notion]`으로 시작하는 각 source bullet을 원본 순서대로
`N0001`부터 번호화한다. 각 항목에는 해당 줄의 canonical category path를 저장한다.

```json
{
  "id": "N0042",
  "kind": "notion_item",
  "requiredPath": ["PIM", "iMX8MP BSP"],
  "sourceLocation": {"line": 366, "column": 5},
  "sourceExcerpt": "[Notion] IIM-42652 내장 IMU 드라이버 브링업 ..."
}
```

AI는 여러 Notion 항목을 한 요약 bullet로 합칠 수 있으며, 이때 해당 marker들을 같은 줄에 나란히
둘 수 있다. 각 `N` ID는 전체 출력에서 정확히 한 번 나타나야 한다.

### 5.3 결정성과 hash

catalog schema는 다음을 포함한다.

```json
{
  "schemaVersion": 1,
  "sections": [],
  "items": [],
  "knownPaths": [],
  "coverageCatalogHash": "sha256(stable payload)"
}
```

ID는 raw source 순서와 config category 순서로 결정한다. 같은 snapshot·config에서는 항상 같은
catalog와 hash가 나와야 한다.

## 6. AI 입력 marker 계약

fact annotation이 원문의 fact surface를 bare reference로 치환한 뒤에도 줄 수는 바뀌지 않는다.
source coverage annotation은 catalog의 source line을 사용해 각 줄 끝에 bare marker를 삽입한다.

```text
원본 섹션:   - iMX8MP BSP
AI 입력:     - iMX8MP BSP [[source:C0005]]

원본 항목:   - [Notion] IIM-42652 내장 IMU 드라이버 브링업 ...
AI 입력:     - [Notion] IIM-42652 ... [[source:N0042]]
```

프롬프트는 다음을 최우선 규칙으로 둔다.

1. `[[source:C....]]`는 해당 section heading에 그대로 둔다.
2. `[[source:N....]]`는 해당 항목을 대표하는 출력 bullet에 그대로 복사한다.
3. 여러 항목을 묶으면 모든 `N` marker를 보존한다.
4. marker ID를 변경하거나 다른 category로 옮기지 않는다.
5. source marker는 사용자에게 보일 내용이 아니므로 해설하거나 표면 문자열로 바꾸지 않는다.

기존의 “사용하지 않는 사실은 문장과 reference를 함께 생략할 수 있다”는 규칙은 fact reference에만
적용하며 source coverage marker에는 적용하지 않는다고 명시한다.

## 7. 구조 및 coverage 검증

`lib/source-coverage.js`는 AI working draft의 source marker를 파싱하고 marker를 제거한 Markdown과
coverage issue 목록을 반환한다.

### 7.1 오류 코드

- `malformed_source_marker`: marker 문법 또는 ID prefix가 잘못됨
- `unknown_source_id`: catalog에 없는 ID
- `missing_source_id`: 필수 ID가 출력에 없음
- `duplicate_source_id`: 같은 ID가 두 번 이상 출력됨
- `source_section_mismatch`: marker가 요구된 canonical path 밖에 있음
- `source_section_heading_mismatch`: `C` marker가 정확한 section heading 줄에 있지 않음

모든 오류는 가능한 경우 ID, required path, actual path, source/output 위치와 excerpt를 포함한다.
첫 오류에서 중단하지 않고 전체 marker와 모든 누락 ID를 수집한다.

### 7.2 canonical path 판정

출력 Markdown을 위에서 아래로 순회하며 catalog의 `knownPaths`에 등록된 상위 category와 고정
subcategory만 구조 노드로 인식한다. AI가 만든 테마 bullet은 path 판정에 사용하지 않는다.

- `C` marker가 있는 줄은 marker 제거 후 텍스트와 들여쓰기가 `requiredPath`의 마지막 요소와
  정확히 일치해야 한다.
- `N` marker가 있는 줄은 현재 활성 canonical path가 `requiredPath`와 같아야 한다.
- `ETC` 항목은 `requiredPath: ["ETC"]`이므로 `Personal AI > Notion` 같은 하위 테마 그룹을 허용한다.

## 8. identifier의 source section 결속

fact catalog의 source fact에는 가능한 경우 `sourceSectionPath`를 추가한다. 값은 coverage catalog의
`knownPaths`와 raw source 위치로 결정하며 catalog hash에 포함한다.

`restoreUnmarkedIdentifierReferences()`는 출력 identifier의 canonical path와 같은
`sourceSectionPath` 후보만 대상으로 기존 문맥 점수를 계산한다. 같은 path 후보가 없거나 모호하면
marker를 복구하지 않고 기존 `unmarked_protected_fact`로 실패하게 둔다.

Claude가 full fact marker를 직접 출력하는 경우도 `validateClaim()`이 marker의 출력 path와
`fact.sourceSectionPath`를 비교한다. 다르면 `fact_section_mismatch`로 차단한다. 이 규칙은
identifier를 포함한 source-bound fact에 적용하되, `sourceLocation: null`인 시스템 사실에는
적용하지 않는다.

이 경계로 Wireless Lan의 `iMX93` fact를 PIM heading에 결속하는 2026-09-01 사고를 차단한다.

## 9. generate·revalidate·update 통합

coverage 계약이 활성화된 새 schema v2 run은 다음 산출물을 추가한다.

```text
out/runs/<meetingDate>/<attemptId>/
  source-coverage.json
```

다음 필드를 run state, global generation state, `prompt-input.json`, validation에 기록한다.

- `sourceCoverageMode: "required_sections_and_notion_v1"`
- `coverageCatalogHash`

generate 순서:

1. sealed snapshot에서 fact catalog와 coverage catalog를 생성·저장한다.
2. fact bare reference와 source bare marker를 원문에 삽입한다.
3. Claude를 기존처럼 정확히 한 번 호출하고 raw output을 immutable 저장한다.
4. 기존 fact reference 확장·identifier 복원 뒤 source coverage를 검증한다.
5. source marker를 제거한 annotated Markdown을 기존 fact validator에 전달한다.
6. coverage와 fact issue를 합쳐 publishability를 판정한다.
7. 둘 다 통과한 clean report만 canonical 경로로 승격한다.

revalidate는 run state에 coverage mode가 있으면 `source-coverage.json`의 소유권과 hash를 확인하고
동일한 coverage→fact 순서로 검증한다. Claude 호출 수는 0회다.

update는 coverage mode가 있는 run에서 coverage catalog/hash 또는 validation 결속이 없거나 다르면
Redmine API 호출 전에 차단한다. 이 오류는 `VALIDATION_OVERRIDE=1`로 우회할 수 없다.

기존 coverage mode가 없는 schema v2 run은 기존 fact-only 계약으로 읽을 수 있게 유지한다.

## 10. 실패 및 수동 수정 정책

- source catalog 생성·annotation 위치가 raw source와 맞지 않으면 Claude 호출 전에 실패한다.
- AI가 source marker를 하나도 반환하면 모든 필수 ID를 `missing_source_id`로 기록하고
  `validation_failed`로 종료한다.
- validation 실패는 같은 run에서 두 번째 Claude 호출을 시작하지 않는다.
- `draft.ai.annotated.md`와 최초 validation revision은 덮어쓰지 않는다.
- 사람은 `draft.working.annotated.md`에 누락 marker와 내용을 복원한 뒤 기존 `MODE=revalidate`로
  재검증한다.
- source marker가 제거된 clean report를 직접 수정하면 기존 report hash gate가 게시를 차단한다.

## 11. 테스트 전략

### 11.1 catalog 및 annotation 단위 테스트

- config category와 non-empty `autoContent`에서 필수 path가 결정적으로 생성된다.
- `(변경 없음)` category는 필수 section에서 제외된다.
- 모든 `[Notion]` source bullet이 고유 `N` ID와 source path를 가진다.
- fact annotation 후에도 source marker가 원래 줄에 정확히 삽입된다.
- 같은 입력의 catalog hash와 marker ID가 반복 실행에서 동일하다.

### 11.2 validator 단위 테스트

- 모든 marker가 정확한 path에 한 번씩 있으면 clean Markdown으로 렌더링된다.
- missing·duplicate·unknown·malformed marker를 한 revision에서 모두 보고한다.
- `PIM > iMX8MP BSP` marker를 `PIM > iMX93 BSP`로 바꾸거나 생략하면 실패한다.
- Wireless Lan의 `iMX93` fact를 PIM 아래에서 자동 복구하거나 full marker로 쓰면 실패한다.
- `ETC` Notion item은 `ETC > Personal AI > Notion` 아래 그룹화를 허용한다.

### 11.3 2026-08-26 사고 회귀 fixture

전체 운영 snapshot을 테스트에 복제하지 않고 사고를 보존하는 최소 fixture를 추가한다.

- `PIM > iMX8MP BSP`에 IIM-42652·Sterling Notion 항목
- `Wireless Lan > iMX93 BSP`에 wlan-package Notion 항목
- Claude 응답이 source/fact marker를 모두 누락하고 PIM heading을 `iMX93 BSP`로 바꾼 사례
- 기대 결과: missing source IDs, section mismatch 또는 unmarked fact가 발생하고 publishable은 false

### 11.4 통합 및 게시 게이트

- fake Claude는 generate당 정확히 1회만 실행된다.
- coverage 실패 뒤 canonical report가 바뀌지 않고 Redmine 요청은 0건이다.
- 수동 marker 복원 후 revalidate는 Claude 0회로 성공한다.
- coverage catalog/hash 변조는 revalidate와 update에서 모두 차단된다.
- coverage 미적용 기존 schema v2 fixture는 기존 경로로 계속 동작한다.
- 전체 `node --test --test-reporter=dot lib/__tests__/*.test.js`가 통과한다.

실제 Claude 파일럿과 Redmine 게시는 코드·회귀 테스트·리뷰가 끝난 뒤 별도 승인 단계로 둔다.

## 12. 완료 조건

- [ ] 내용이 있는 설정 기반 section이 정확한 canonical path에 한 번씩 존재한다.
- [ ] 보고 입력의 모든 `[Notion]` 항목 ID가 정확히 한 번 출력된다.
- [ ] source marker 누락·중복·변조·오배치가 publish를 차단한다.
- [ ] identifier fact는 원본 canonical path 밖에서 자동 복구되거나 검증 통과하지 않는다.
- [ ] 2026-08-26 `iMX8MP`→`iMX93` 사고 fixture가 수정 전 실패하고 수정 후 통과한다.
- [ ] 기존 protected fact exact-copy와 open-status/pickaxe 검증이 그대로 통과한다.
- [ ] validation 실패가 Claude 재호출 또는 Redmine 요청을 유발하지 않는다.
- [ ] coverage 적용 run의 catalog/hash/report 소유권이 generate·revalidate·update 전 구간에서 확인된다.
- [ ] coverage 미적용 기존 schema v2 run의 호환 경로가 유지된다.
