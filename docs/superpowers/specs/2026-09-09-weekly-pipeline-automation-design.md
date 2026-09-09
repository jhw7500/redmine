# Redmine 주간보고 2단계 자동화 설계

사용자는 2026-09-09 대화에서 매주 06:45 Redmine 게시까지 사람 확인 없이 자동화하고,
선행 단계가 실패하면 서버의 기존 내용을 유지하며, 실패 원인을 로그와 보존 산출물에 직접
남기는 운영 계약을 승인했다.

## 배경과 근본 원인

2026-09-09 06:15 생성은 원문 선택 기반 구현이 운영 `main`에 병합되기 전에 실행됐다.
자유 요약 결과가 depth 및 사실 검증을 통과하지 못했고 정식 보고서가 승격되지 않았지만,
06:45 `update` 크론은 독립적으로 다시 실행돼 `초안 파일이 없습니다`라는 2차 실패를 만들었다.
13:56 원문 선택 구현이 병합된 뒤에는 `2.12-rc1/2.12` 같은 버전 범위를 비율로 오인하는
`unmarked_protected_fact`가 별도로 재현됐다. 후속 브랜치는 버전 범위 판별, 실패 초안 보존,
depth별 선택량, Notion 원인·수정·검증 보존을 수정했으며 동일 기간 depth 3 실데이터 생성에서
차단 오류 0건을 확인했다.

따라서 자동화 실패의 근본 원인은 하나의 모델이나 한 문장이 아니라 다음 세 경계가 분리된
상태였다는 점이다.

1. 크론 운영 설정과 검증된 생성 방식 사이에 배포 간극이 있었다.
2. `collect`, `generate`, `update`가 독립된 크론이라 선행 실패가 후행 단계에 전달되지 않았다.
3. 실패 원인은 run 내부 여러 파일에 흩어졌고, cron 로그에는 대표 원인이 항상 출력되지 않았다.

## 목표

- 수요일 06:05에 수집·원문 선택 생성·검증을 하나의 준비 단계로 실행한다.
- 06:45 게시 단계는 같은 회의일의 검증된 READY 증거가 있을 때만 자동 게시한다.
- 준비 실패 뒤 게시 단계는 Redmine API를 호출하지 않고 중복 경고 없이 건너뛴다.
- 모든 실패는 사람이 바로 읽을 수 있는 로그 한 줄과 보존되는 JSON/Markdown 산출물을 남긴다.
- PUT 성공 뒤 서버를 다시 조회해 실제 조현우 섹션이 기대 문자열과 일치해야 게시 성공으로
  확정한다.
- 기존 수동 `collect`, `generate`, `revalidate`, `update` 모드는 유지한다.

## 선택한 구조

세 개의 독립 크론을 두 개의 명시적 파이프라인 모드로 교체한다.

```text
06:05 weekly-prepare
  collect -> source_selection generate -> validation -> READY
      | failure
      +-> failure artifacts + one alert

06:45 weekly-publish
  FAILED  -> SKIP, exit 0, no Redmine request
  missing/incomplete -> failure artifact + alert
  READY   -> evidence/hash validation -> PUT -> GET verification -> PUBLISHED
```

`weekly-prepare`는 기존 `runCollect()`과 `runGenerate()`를 같은 프로세스와 기존
`out/report-run.lock` 아래에서 순서대로 호출한다. 성공한 generate가 만든 schema v2 증거를
파이프라인 READY 상태에 결속한다. `weekly-publish`는 READY가 가리키는 snapshot, generation
state, clean report의 hash와 attempt 소유권을 재검증한 뒤 기존 `runUpdate()`를 호출한다.

운영 설정은 crontab에 길게 복제하지 않고 저장소의 두 래퍼가 소유한다.

```text
run-weekly-prepare-env.sh
  MODE=weekly-prepare
  AI_SUMMARIZE=1
  AI_PROVIDER=codex
  AI_MODEL=gpt-5.6-sol
  AI_EFFORT=low
  AI_GENERATION_METHOD=source_selection
  AI_GENERATION_SCOPE=whole
  SOURCE_SELECTION_FALLBACK=1
  REPORT_DEPTH=3
  PRESENTATION_NOTE_MODE=suggest

run-weekly-publish-env.sh
  MODE=weekly-publish
  AUTO_APPROVE=1
  VALIDATION_MODE=block
  REPORT_DEPTH=3
  PRESENTATION_NOTE_MODE=suggest
```

일반 실행의 `freeform` 기본값은 호환성과 비교 실행을 위해 유지한다. 크론 전용 래퍼만 검증된
운영 프로필을 강제한다. `MEETING_DATE`, `OUTPUT_DIR`, `SNAPSHOT_PATH`는 명시한 수동 복구
실행에서 기존처럼 오버라이드할 수 있다.

## 파이프라인 상태

현재 회의일의 상태는 다음 경로에 원자적으로 기록한다.

```text
out/pipeline/YYYY-MM-DD/status.json
```

상태 스키마는 다음 필드를 가진다.

```json
{
  "schemaVersion": 1,
  "meetingDate": "2026-09-16",
  "pipelineAttemptId": "uuid",
  "reportDepth": 3,
  "status": "preparing|ready|publishing|published|failed",
  "stage": "collect|generate|validate|publish|publish_verify",
  "startedAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "snapshotPath": "absolute path",
  "snapshotHash": "sha256",
  "generationAttemptId": "uuid",
  "generationStatePath": "absolute path",
  "reportPath": "absolute path",
  "reportHash": "sha256",
  "expectedSectionHash": "sha256 or null",
  "failureArtifact": "absolute path or null",
  "published": {
    "wikiTitle": "page title",
    "version": 12,
    "updatedOn": "ISO-8601",
    "sectionHash": "sha256",
    "verifiedAt": "ISO-8601"
  }
}
```

상태별 필수 필드는 코드에서 검증한다. `ready`는 snapshot과 generation/report 증거가 모두
있어야 하며 `published`는 서버 재조회 메타데이터까지 있어야 한다. `published` 객체는 게시
전에는 `null`이다. 다른 회의일, 다른 depth, 경로 이탈, symlink, hash 또는 attempt 불일치는
READY로 취급하지 않는다.

구현에서 확정된 `reportDepth`는 pipeline attempt 자체에 고정되는 양의 정수이고, 주간 래퍼는
항상 `3`만 허용한다. READY 이후에는 pipeline과 generation 증거 양쪽의 depth가 모두 `3`이어야
한다. `published.version`은 PUT 후 authoritative GET이 반환한 Wiki version이며,
`published.sectionHash`는 `expectedSectionHash`와 같아야 한다. 이미 `published`인 attempt를 다시
실행하면 stdout에는 정확히 `[weekly][SKIP] already-published` 한 줄만 내고, 기존 `published`
객체는 status/result에 그대로 보존하며 새 Redmine 요청·장애 산출물·알림을 만들지 않는다.

허용 전이는 `preparing -> ready|failed`, `ready -> publishing|failed`,
`publishing -> published|failed`뿐이다. READY 증거가 게시 전에 달라진 경우에는 외부 쓰기 없이
`ready -> failed`로 전이한다.
`publishing`에서 프로세스가 끝난 상태는 다음 실행에서 완료로 추정하지 않고 중간 종료 실패로
처리한다. PUT 직전에는 `expectedSectionHash`를 상태에 먼저 기록해 쓰기 시도 범위를 남긴다.
수동 재실행은 기존 상태를 이어 쓰지 않고 새 `pipelineAttemptId`로 시작한다.

상태 파일은 임시 파일 작성, `fsync`, rename 순서로 교체한다. 기존 전역 실행 락을 유지해
prepare와 publish 또는 수동 보고 명령이 동시에 상태와 보고서를 바꾸지 못하게 한다.

## 실패 원인 산출물

각 실패는 현재 상태와 별개로 다음 경로에 보존한다.

```text
out/pipeline/YYYY-MM-DD/failures/<timestamp>-<stage>-<pipelineAttemptId>.json
out/pipeline/YYYY-MM-DD/failures/<timestamp>-<stage>-<pipelineAttemptId>.md
```

JSON은 기계 판독용이며 다음을 포함한다.

- `schemaVersion`, `meetingDate`, `pipelineAttemptId`, `occurredAt`
- `stage`, 안정된 `code`, 정제된 `message`
- validation 실패일 때 오류 코드별 개수와 대표 issue
- snapshot, generation state, provider 원본, working/rejected/clean report, validation 경로 중
  실제 존재하는 산출물 목록
- `redmineWriteAttempted`와 `serverState` (`unchanged`, `written_unverified`, `verified`)

안정된 오류 코드는 최소한 `collect_failed`, `ai_failed`, `source_selection_invalid`,
`validation_failed`, `prepare_incomplete`, `ready_evidence_mismatch`, `publish_http_failed`,
`publish_incomplete`, `publish_verify_mismatch`를 구분한다. validation의 세부 issue code는
별도 집계에 원형 그대로 남긴다.

Markdown은 회의 직전에도 읽을 수 있도록 같은 사실을 다음 순서로 렌더링한다.

1. 실패 단계와 한 줄 원인
2. 오류 코드별 개수와 대표 오류
3. 서버 변경 여부
4. 확인할 산출물 경로
5. 같은 회의일 재실행 명령

실패 파일은 생성 후 덮어쓰지 않는다. 같은 회의일을 재실행하면 새 pipeline attempt와 새 실패
파일을 만들며 이전 실패 증거는 남긴다. generate 검증 실패 시 기존 run의 provider 원본,
`draft.working.annotated.md`, `report.rejected.NNN.md`, `validation.NNN.json`도 계속 보존한다.

오류 메시지와 stack은 길이를 제한하고 API key, Authorization 헤더, URL credential, 알려진
token 패턴을 마스킹한다. HTTP 응답 header 전체나 인증정보가 들어갈 수 있는 원문 body는 실패
요약에 복사하지 않는다.

cron stdout에는 다음 한 줄을 출력한다.

```text
[weekly][FAIL] stage=validate code=unmarked_protected_fact cause="버전 범위를 비율로 오인" artifact=/.../failure.md
```

상세 validation은 기존 JSON에 남기고 로그 한 줄에는 stage, code, 짧은 cause, artifact 경로만
둔다. `run-report-env.sh`의 기존 알림은 prepare의 비정상 종료를 한 번 전달한다.

## 게시 게이트와 실패 의미

`weekly-publish`는 상태를 다음처럼 처리한다.

| 준비 상태 | 동작 | 종료 | 알림 |
|---|---|---:|---|
| `failed` | `[weekly][SKIP]`와 기존 failure 경로 출력, Redmine 미호출 | 0 | 없음 |
| `published` | `[weekly][SKIP] already-published` 출력, status의 기존 검증 메타데이터 보존, Redmine 미호출 | 0 | 없음 |
| 상태 없음 또는 `preparing` 중단 | `prepare_incomplete` 실패 산출물 생성, Redmine 미호출 | 비정상 | 1회 |
| `publishing` 중단 | `publish_incomplete` 기록, 자동 재게시하지 않음 | 비정상 | 1회 |
| 회의일/depth/hash/attempt 불일치 | `ready_evidence_mismatch` 실패, Redmine 미호출 | 비정상 | 1회 |
| `ready` | 게시 직전 전체 증거 재검증 후 PUT | 계속 | 없음 |

prepare가 실패했을 때는 이미 prepare 크론이 원인과 알림을 남겼으므로 06:45 publish는 정상
skip한다. prepare 자체가 실행되지 않았거나 상태 기록 전에 강제 종료된 경우에는 publish가
이를 새로운 `prepare_incomplete` 장애로 보고한다.

PUT 뒤에는 같은 wiki JSON을 다시 GET하고 `extractSection()`으로 조현우 섹션을 추출한다.
서버 섹션과 PUT에 사용한 `finalSection`의 정규화 문자열 및 hash가 모두 일치할 때만
`published`로 전이한다. 불일치는 `publish_verify_mismatch`로 기록한다. 이 경우 쓰기가 이미
적용됐을 수 있으므로 `serverState=written_unverified`를 명시하고 자동 rollback은 하지 않는다.

발표노트 Issue 생성 및 종료는 기존 depth 3 `suggest` 계약을 유지한다. 게시 전 issue 생성도
기존 `assertReady`를 통과해야 한다. Wiki 게시 뒤 발표완료 종료의 best-effort 정책은 본 설계의
성공 판정에 포함하지 않는다.

## 크론 전환

현재 06:05 collect, 06:15 generate, 06:45 update 세 항목을 다음 두 항목으로 교체한다.

```cron
5 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-prepare-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
45 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-publish-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
```

전환 직전 `crontab -l`을 날짜가 붙은 로컬 백업으로 남긴다. 다른 cron 항목은 유지한다. 적용
후 다시 조회해 기존 세 항목이 없고 새 두 항목이 정확히 한 번씩 존재하는지 검증한다.

## 테스트와 인수 기준

1. `weekly-prepare` 정상 실행은 sealed snapshot과 schema v2 complete generation을 만들고
   `status=ready`에 동일 hash와 attempt ID를 기록한다.
2. collect, AI 실행, source selection, validation 각 실패는 원인 코드와 실제 산출물 경로를
   JSON/Markdown 및 cron stdout에 남긴다.
3. validation 실패 보고서는 정식 파일로 승격되지 않아도 rejected 산출물로 남는다.
4. `status=failed` 뒤 `weekly-publish`는 exit 0이고 Redmine 요청 수가 0이다.
5. 상태 없음, 중간 종료, 잘못된 회의일/depth, 변조된 snapshot/state/report는 Wiki와 Issue
   요청 전에 차단된다.
6. 정상 READY에서는 자동 승인 게시를 수행하고 PUT 후 GET의 원격 섹션 일치를 검증한다.
7. PUT 성공 후 GET 불일치는 `written_unverified` 실패 산출물과 비정상 종료를 만든다.
8. 같은 회의일 실패 후 재실행 성공 시 이전 실패 파일은 유지되고 현재 status만 새 attempt를
   가리킨다.
9. Node 22.23.1과 운영 Node 24.12.0에서 전체 테스트를 통과한다.
10. 최소 cron 환경에서 두 wrapper가 저장소 자신의 `index.js`를 실행하며 운영 프로필을 정확히
    전달한다.
11. 2026-09-09 canonical sealed snapshot 회귀 실행은 depth 3 게시 가능 보고서를 생성한다.
    저장된 snapshot 하나에 두 사고 사실이 모두 없으므로, `wpa_supplicant 2.12-rc1/2.12`는
    no-I/O exact-string validator로 버전 범위 보존을 확인하고, 듀얼와이드의 동일 `exp_time`·서로
    다른 `ae_on` 원인과 수정·검증 문구는 최신 saved v5 sealed snapshot 및 그 complete
    source-selection run으로 확인한다.
12. 실제 운영 전환 전 dry-run prepare, 로컬 fake Redmine 통합 테스트, 실제 crontab 조회를
    완료하고, 전환 뒤 다음 수요일의 READY/PUBLISHED 상태와 서버 재조회 증거를 확인한다.

## 범위 밖

- validation 규칙 완화 또는 `VALIDATION_OVERRIDE` 자동 사용
- AI provider 자동 재호출이나 다른 provider로의 자동 fallback
- 게시 검증 실패 시 서버 페이지 자동 rollback
- 과거 모든 회의 보고서 재생성
- Redmine 전체 페이지 형식 변경

## 구현 경계

- 파이프라인 상태·실패 산출물 책임은 새 `lib/weekly-pipeline.js`에 둔다.
- 기존 `runCollect`, `runGenerate`, `runUpdate`는 재사용 가능하도록 `index.js`에서 호출하되,
  수동 모드의 동작과 종료코드는 바꾸지 않는다.
- PUT 후 GET 확인은 `lib/publisher.js`가 원격 page metadata와 최종 섹션을 반환하도록 확장하고,
  파이프라인 계층이 기대 hash를 검증한다.
- 운영 프로필은 새 `run-weekly-prepare-env.sh`, `run-weekly-publish-env.sh`가 소유한다.
- 파이프라인 단위·통합 테스트는 `lib/__tests__/weekly-pipeline.test.js`와 기존 publisher/index/wrapper
  테스트에 둔다.

## Execution Notes

- Ruling: 저장된 2026-09-09 snapshot 중 `wpa_supplicant 2.12-rc1/2.12` literal과 hydrated
  듀얼와이드 원인·수정·검증을 동시에 가진 파일은 없다. sealed input을 수정하거나 합성하지 않고,
  canonical snapshot의 일반 offline replay, exact-string no-I/O version validator, 최신 saved v5
  sealed snapshot의 complete depth-3 source-selection evidence로 인수 증거를 분리한다. 이 판정이
  틀리면 단일 artifact 재현성이 부족하므로 두 입력 사실을 모두 가진 새 sealed snapshot을 수집해
  다시 replay해야 한다.
- Canonical replay: snapshot file SHA-256
  `ec5aa022f43eb20c52f6a2a832945f7c34964dc16d4b464ae6fe46312ff2fa0a`, report SHA-256
  `b5d0f867228b9bab97b27da645c1d201ab6046dbba5bcb5707a83f3efdd5e065`, publishable
  `WARNING`, error blocker 0.
- Saved v5 evidence: snapshot file SHA-256
  `0c5415aefba0694e3bff304c25132043df02e86fa46922b56c0c5a93312426a9`, run state SHA-256
  `05e15c2364c473123797778745abac379f53678257cd352b33982771a05dceee`, clean report SHA-256
  `59771afb0e1419fbd17989e19ea857ee08bf69134fe8763ad54630326084e6fe`, validation SHA-256
  `ed3c16038ca47db7575b0a1492592f28971624676906a9213168f4232bcdc708`; state `complete`,
  depth 3, method `source_selection`, validation `WARNING`, error blocker 0.
