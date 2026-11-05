# 원천 날짜 꼬리와 백슬래시 표식 오탐 보완 (#143)

## 목표와 경계

원천에 있던 파일·경로의 날짜 꼬리와 백슬래시 뒤 보호 값을 그대로 인용할 수 있게 한다. 출력 파서와 공용 `extractSchemaV2FactOccurrences`의 문법·후보 선택은 바꾸지 않는다. 표식 없는 측정값, 알려지지 않은 참조, 이스케이프된 출력 표식은 계속 거부한다.

## C1: 날짜 꼬리의 좁은 예외

원천 추출은 ISO 날짜와 겹친 파일명 꼬리를 제외하지만, 출력 추출은 날짜의 표식 구간을 먼저 빼면서 꼬리가 다시 드러난다. validator가 `unmarked_protected_fact`를 만들기 직전에만 다음을 모두 확인한다.

- 후보는 `attached_unit`이며 정확한 날짜 표식의 마지막 두 자릿수에서 시작해 그 표식 밖으로 연장된다.
- 표식의 ID·표면값·출력 구간이 실제 catalog의 ISO 날짜 및 원천 구간과 일치한다. 원천 추출도 그 위치를 ISO 날짜로 선택했어야 한다.
- 후보 전체가 하나의 파일·경로 토큰 안에 있다. 경로 구분자 또는 파일 확장자가 없는 일반 문장의 날짜 꼬리는 예외가 아니다.
- 같은 fact의 원천 위치에서 얻은 파일·경로 토큰과 출력 토큰이 일치한다. 무관한 원천 줄을 전역 검색해 승인하지 않는다.

역슬래시가 여러 fact 앞에 있는 파일 토큰은 각 치환 위치가 그 토큰의 실제 원천 annotation 위치와 일치해야 한다. 날짜 바로 앞뿐 아니라 같은 경로의 버전·수량 앞 치환도 확인한다. 다른 토큰에서 빌린 fact나 그 밖의 토큰 변경은 허용하지 않는다.

## C2: AI 입력 사본만 중립화

`annotateFactReferences`는 원천과 catalog 구간·raw 일치 검증을 먼저 끝낸다. 표식을 삽입할 때 바로 앞의 마지막 ASCII 역슬래시 한 문자만 U+2216(∖)으로 바꾼다. U+2216은 UTF-16 길이 1이며 NFKC에서도 역슬래시가 되지 않는다.

현재 파서는 역슬래시 run의 홀짝을 구분하지 않으므로 1·2·3개 run 모두 이 마지막 문자만 바꾼다. 원천 문자열·catalog·오프셋·해시는 유지한다. 출력 파서가 원래의 `\[[fact:`를 거부하는 규칙과 AI 호출 전 차단 검사를 다시 넣지 않는 경계도 유지한다.

안전한 annotation을 파싱한 뒤, catalog의 annotation owner와 원천 raw·위치·행·열·excerpt 및 바로 앞 ASCII 역슬래시가 확인되는 claim만 복원 위치로 기록한다. 이 위치의 문자만 의미 대조용·최종 clean 문자열에서 ASCII 역슬래시로 복원한다. 원래부터 있던 U+2216과 확인되지 않은 문자는 유지한다. annotated draft와 그 해시는 바꾸지 않으며, marker 밖 보호 사실 추출도 원래 파싱된 사본으로 수행한다. 최종 clean 문자열의 해시·canonical 저장·게시 근거는 기존 소비 경로에서 일관되게 계산한다.

원천 앞 글자만으로 복원하지 않는다. AI 응답 이후 validator에서 기존 annotate → expand → parse로 비교 전용 원천 투영을 만들고, 출력 줄의 전체 본문과 fact ID·상대 구간이 같은 원천 줄을 가리킬 때만 복원한다. 이 투영은 M.display를 포함하며 저장된 annotation·catalog·hash를 바꾸지 않는다. 들여쓰기·선두 bullet 하나·본문 전체를 감싼 underline 한 겹만 비교용으로 허용하고 내부 공백·구두점·slash run·Unicode는 보존한다.

같은 비교 본문이 다른 원천 줄의 genuine U+2216으로도 설명되면 해당 줄 전체를 복원하지 않는다. 이 모호성 검사는 fact ID에 한정하지 않는다. 이동한 문맥·모호한 줄·줄을 넘는 등 확인할 수 없는 후보는 문자를 보존하면서 기존 non-overridable `fact_evidence_mismatch`로 차단한다. 원래 Unicode 앞 fact는 ASCII 복원 후보가 아니므로 그대로 유지한다.

## fail-open 분석

- 겹침 자체를 승인하지 않는다. `-08 ms`, ratio 뒤 단위, 백분율 등 다른 후보 종류와 파일 밖 후보는 그대로 실패한다.
- source에 없는 파일 꼬리, 다른 날짜 fact로 바꾼 참조, 추가한 표식 밖 `30ms`는 승인하지 않는다.
- C2는 새 출력 문법을 허용하지 않는다. AI가 ASCII 역슬래시를 다시 붙인 표식과 표식 없는 보호 값은 기존 파서·validator에서 실패한다.
- 최종 복원은 전역 `∖` 치환이 아니다. 해당 원천 claim만 복원하며, 파일 토큰 비교는 모든 치환의 원천 offset까지 대조한다. 복원 과정에서 marker를 다시 파싱하거나 잘못된 marker를 복구하지 않는다.
- 실제 source projection과 출력 줄의 본문·fact 위치를 함께 확인하며, 다른 문맥으로 옮긴 같은 ID와 genuine Unicode 충돌도 차단한다. 모든 후보는 복원되거나 오류 처리된다.
- 원천 표식 중립화·unknown-reference 보존·`FACT_SOURCE_MISMATCH`·겹친 catalog 거부 테스트의 기존 기대값은 유지한다.

## 검증

- C1: 실제 `2026-11-04-weekly-best-effort-publish.md` 경로, basename, 원천 꼬리 변조, 다른 fact 선택, 표식 밖 측정값 추가, 기존 보호 suffix 테스트.
- C2: 09-23의 literal backslash-n 줄, 역슬래시 뒤 수량·버전, 여러 run, 원천·catalog·snapshot 해시 불변, 실제 생성 진입에서 AI 호출 유지.
- 최종 clean 바이트의 역슬래시 복원·genuine U+2216 보존, 버전과 날짜를 함께 가진 경로, 실패 draft 수정 후 AI 재호출 없는 revalidation, source-selection의 모의 게시와 해시 일치를 확인한다.
- 기존 파서·공용 추출기와 보호하도록 지정된 기존 테스트를 수정하지 않는다. 현재 잘못된 annotation을 기대하는 생성 회귀의 기대값만 새 사본에 맞추며 AI 호출 assertion은 유지한다.
- 모든 보존된 `out/pairs/*/source/snapshot.json`을 catalog → annotate → expand → parse로 재생하고 결과를 별도 artifact에 기록한다.
- 전체 Node 테스트의 실행·통과·실패·건너뜀 수를 기록한다.
- 11-11 회의일 리허설은 임시 출력 디렉터리에서 준비 단계로 수행한다. 독립 검증은 저장된 application 산출물의 hash/공용 계약 재검증과 fake AI·fixture 기반 prepare transport 회귀로 수행한다. 과거 controller의 전송 계측은 원문 artifact로 보존하고 독립 측정으로 재표현하지 않는다.

## 호환성과 운영

과거 source-selection run은 새 annotation으로 재구성한 source records의 해시와 다를 수 있다. 변경 전 준비한 pair/run을 새 코드로 이어 게시하지 않고 다시 준비한다. 검증을 우회해 옛 근거를 승인하지 않는다.

머지·운영 반영·서버 쓰기는 사용자 승인 후 진행한다. 운영 반영은 2026-11-11 07:05 KST 이후이며 수요일 06:05~07:05 KST를 피한다.
