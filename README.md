Redmine weekly meeting automation (조현우 section) - API

Setup
- Uses Node 18+ (built-in fetch)
- Set credentials via env vars.
- AI provider/model, `whole|project` 분할과 운영 예시는 [주간보고 AI 생성 사용 가이드](docs/ai-generation-usage.md) 참조.

Required env vars
- `REDMINE_API_KEY` (`MODE=update`에서만 필수)

Optional env vars
- `REDMINE_BASE_URL` (default: http://192.168.10.2:30002)
- `WIKI_URL` (set to override auto-selected next Wednesday page)
- `MEETING_DATE` (override, format: YYYY-MM-DD)
- `TEMPLATE_PATH` (default: /home/jhw/ai/codex/redmine-auto/templates/jo-hyunwoo.md)
- `SECTION_HEADER` (default: #### <span style="color:blue">조현우</span>)
- `PROJECT_ID` (default: advance-development-team)
- `PAGE_SUFFIX` (default: 선행개발팀_주간_회의)
- `REPO_ROOT` (default: /home/jhw/ai/codex/projects)
- `REPO_LIST` (comma-separated absolute repo paths; overrides REPO_ROOT)
- `AUTHOR_MATCH` (default: empty = all authors)
- `EXTRA_NOTES_PATH` (default: empty)
- `INCLUDE_MERGES` (set to 1 to include merge commits)
- `OUTPUT_DIR` (default: /home/jhw/ai/codex/redmine-auto/out)
- `OUTPUT_PATH` (default: OUTPUT_DIR/jo-hyunwoo-YYYY-MM-DD.depthN.md; 명시하면 해당 경로를 그대로 사용)
- `MODE` (`collect`=수집 snapshot 생성, `generate`=snapshot에서 depth 파일 생성, `revalidate`=실패한 AI run 재검증, `update`=검증된 파일을 Redmine에 반영, `prune`=오래된 schema v2 run 정리)
- `RUN_ID` (`MODE=revalidate`에서 필수인 schema v2 run UUID)
- `RUN_ARTIFACT_RETENTION_DAYS` (default: `90`; 이 기간이 지난 terminal run만 정리 대상)
- `PRUNE_APPLY` (`MODE=prune`에서 `1`이면 실제 삭제, 미설정 시 dry-run)
- `REPORT_DEPTH` (default: 2 — 보고서 상세도. 1=요약, 2=표준, 3=중간, 4=상세. repo-config.json `defaults.reportDepth`/`depthProfiles` 참조)
- `SNAPSHOT_PATH` (default: `OUTPUT_DIR/report-YYYY-MM-DD.snapshot.json`)
- `FORCE_COLLECT` (`1`이면 sealed snapshot을 재수집. 원본이 바뀌면 기존 snapshot을 hash 이름으로 보존)
- `ALLOW_PARTIAL_SNAPSHOT` (`1`이면 일부 source 수집 실패 snapshot도 generate/update에 사용)
- `VALIDATION_MODE` (`block` 기본, `warn`이면 사실 검증 실패를 경고하고 update 계속)
- `VALIDATION_OVERRIDE` (`1`이면 schema v1 검증 실패를 명시적으로 수동 우회. schema v2의 사실·hash 오류는 우회 불가)
- `PRESENTATION_NOTE_MODE` (`tagged` 기본. `suggest`=자동 후보 기록+명시 태그만 게시, `auto`=자동 후보도 게시, `off`=비활성)
- `PRESENTATION_NOTE_THRESHOLD` (자동 발표노트 후보 점수, 기본 5)
- `LEADER_HIGHLIGHT` (default: 0 — 팀장 회의 보고용 중요 항목 밑줄(`<u>`) 강조. 1=사용. repo-config.json `reportFilter.leaderHighlight.enabled`보다 우선)
- `LEADER_HIGHLIGHT_MAX` (default: 0 = 무제한 — 밑줄 최대 줄 수. N>0이면 AI에 상한 지시. repo-config.json `reportFilter.leaderHighlight.maxLines`보다 우선)
- `AI_SUMMARIZE` (`1`이면 generate 단계에서 AI 요약 사용. 미설정 시 원본 초안 사용)
- `AI_PROVIDER` (`claude|codex`, default: `claude` — Codex는 품질 비교 후 선택하는 후보이며 자동 fallback하지 않음)
- `AI_MODEL` (provider별 default: Claude `sonnet`, Codex `gpt-5.6-sol` — 주간보고 전용 모델. 사용자 전역 모델을 상속하지 않음)
- `AI_EFFORT` (default: `low`; `low|medium|high|xhigh|max`)
- `AI_GENERATION_SCOPE` (`whole|project`, default: `whole` — `whole`은 전체 보고서 1회 호출, `project`는 내용이 있는 PIM/Wireless Lan/ETC를 순서대로 호출한 뒤 병합)
- `CLAUDE_CLI` (default: `claude`)
- `CODEX_CLI` (default: `codex`)
- `AI_MAX_INPUT_CHARS` (default: `100000` — AI에 전달할 호출별 prompt 문자 수 상한. 초과 시 호출 전 중단)
- `AI_TIMEOUT_MS` (default: `300000` — AI 단일 호출 timeout, 양의 정수)
- `AI_MAX_BUDGET_USD` (선택 — 설정 시 Claude CLI `--max-budget-usd`로 전달, 양수)
- `AI_EN_PATH` (default: /home/jhw/ai/codex/redmine-auto/templates/ai-en.md)
- `AI_KO_PATH` (default: /home/jhw/ai/codex/redmine-auto/templates/ai-ko.md)
- `GITHUB_TOKEN` (optional: enables PR title lookup)
- `GITHUB_OWNER` (default: jhw7500)

Template
- Edit `redmine-auto/templates/jo-hyunwoo.md` with the exact content to publish.
- You can use `{{START_DATE}}`, `{{END_DATE}}`, and section placeholders:
  - `{{PIM_APPLICATION_KO}}`, `{{WIRELESS_NXP_KO}}`, `{{WORKFLOW_KO}}`
  - `{{EXTRA_NOTES_EN}}`, `{{EXTRA_NOTES_KO}}`
  - `{{AI_KO}}`
- Only the section matching the exact header text is replaced; the rest of the page is preserved.

Notes
- `WIKI_URL` can be the normal wiki page URL or the `/edit?section=...` URL.
- If `WIKI_URL` is not set, the script targets the next Wednesday based on local time.
- 자동 수집 범위는 매주 수요일 06:00 KST를 경계로 나눈다(지난 수요일 06:00부터 이번 수요일 05:59:59까지).
- Workflow 요약은 핵심 항목만 출력하며, 한글에서도 'workflow'를 그대로 사용합니다.
- `GITHUB_TOKEN`이 있으면 PR 제목/본문 요약을 자동으로 채웁니다.

Run
- Collect once: `MODE=collect MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Draft only: `MODE=generate REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Project-split draft: `MODE=generate AI_SUMMARIZE=1 AI_GENERATION_SCOPE=project REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Codex candidate draft: `MODE=generate AI_SUMMARIZE=1 AI_PROVIDER=codex AI_GENERATION_SCOPE=whole REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Revalidate a failed AI run without Claude: `MODE=revalidate RUN_ID=<uuid> MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Update from validated file: `MODE=update REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Preview expired run cleanup: `MODE=prune ./run-report-env.sh`
- Apply expired run cleanup: `MODE=prune PRUNE_APPLY=1 ./run-report-env.sh`
- Depth 비교 테스트: 먼저 `MODE=collect ./run-report-env.sh` 실행 후 `./run-depth-test.sh` — 동일 sealed snapshot으로 depth 1/2/3/4 생성·검증

Weekly unattended operation

주간 자동화는 저장소의 두 래퍼만 호출한다. prepare 래퍼는 수집부터 depth 3
`source_selection` 생성·검증과 READY 증거 결속까지 한 번에 수행하고, publish 래퍼는 같은
회의일의 READY snapshot/generation/report hash를 다시 검증한 뒤에만 Redmine 쓰기를 시작한다.
일반 `collect`, `generate`, `revalidate`, `update`, `prune` 명령과 일반 generate의 `freeform`
기본값은 그대로 유지된다.

depth3의 원문 기반 대체보고서는 본문 또는 부모 문맥에 상세 설명이 붙은 원문 항목을 먼저
선택하고, 설명을 재작성하지 않고 보존한다. 상세 항목이 많으면 최소 분량에서 멈추지 않고
기존 선택 상한까지 담는다. 섹션 공통 설명은 선택된 자식에 함께 남기며, 공통 설명만으로
모든 자식을 필수 선택하지는 않는다. 상세 항목이 누락되면 `source_selection_detail_missing`으로
게시를 차단하며, 검증 JSON에 원문 ID·섹션·항목명과 복구 안내를 남긴다. 경고 허용이나
수동 override로 우회할 수 없고, 과거 WARNING 대체본도 게시 직전에 재검사한다.
실패한 생성물은 아래의 rejected 경로에 보존한다. 원문·선택 분량을 확인한 뒤 새
`generate`/`weekly-prepare`가 필요하며, 단순 `revalidate`는 고정된 선택을 바꾸지 않는다.
정상 AI 선택 및 다른 depth의 선택 규칙은 변경하지 않는다.

새 수집본은 보고 대상 Notion 항목의 요약을 `출처 요약`으로 원문에 함께 보존한다.
선택된 항목의 요약은 결과·조건·검증 한계를 분리하지 않고 전부 렌더링하지만, 요약만
추가되었다는 이유로 그 항목을 fallback 필수 선택으로 승격하지는 않는다. 기존 본문과
원인·수정·검증 상세 보호, depth3 전체 32개·섹션별 9개 상한은 유지한다.
이 구분은 새 snapshot의 `sourceDetails`에 봉인한 원본 항목·부모·줄 범위를 재검증해 적용한다.
문구만으로 예외 처리하지 않으며, 출처 정보가 없는 과거 snapshot은 기존 규칙을 유지한다.
기존 sealed snapshot에는 요약이나 출처 정보를 소급 추가하지 않는다.

전환할 cron 항목은 정확히 다음 두 줄이다. 실제 crontab 교체 전에는 기존 내용을 별도 파일로
백업하고, 다른 항목이 byte 단위로 유지되는지 확인한다.

```cron
5 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-prepare-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
45 6 * * 3 /home/jhw/ai/opencode/projects/redmine/run-weekly-publish-env.sh >> /home/jhw/ai/opencode/projects/redmine/out/cron.log 2>&1
```

회의일별 상태와 실패 증거는 다음 위치에 남는다.

| 경로 | 의미 |
| --- | --- |
| `out/pipeline/YYYY-MM-DD/status.json` | 현재 attempt의 `preparing`, `ready`, `publishing`, `published`, `failed` 상태와 depth/hash/게시 검증 증거 |
| `out/pipeline/YYYY-MM-DD/failures/<timestamp>-<stage>-<attempt>.json` | 안정된 오류 code, 원래 세부 `primaryIssueCode`, issue 집계, 산출물 hash, Redmine 쓰기 여부와 서버 상태 |
| `out/pipeline/YYYY-MM-DD/failures/<timestamp>-<stage>-<attempt>.md` | 원인, 대표 issue, 서버 상태, 확인할 산출물, 같은 회의일 재실행 명령을 읽기 순서로 정리한 장애 기록 |

`[weekly][FAIL]`은 비정상 종료와 함께 `stage`, 가장 구체적인 detail code, 짧은 원인,
Markdown 장애 파일을 한 줄로 가리킨다. 안정된 분류 code와 `primaryIssueCode`는 JSON에서
확인하며, Markdown은 원인·issue 집계와 예시·서버 상태·산출물·재실행 명령을 제공한다.
`[weekly][SKIP] status=failed`는 prepare가 이미 실패해 publish가 exit 0으로 끝났다는 뜻이고,
`[weekly][SKIP] already-published`는 검증 완료한 같은 attempt를 멱등하게 건너뛴다는 뜻이다.
두 SKIP 모두 새 장애 파일이나 알림을 만들지 않고 Redmine 요청도 보내지 않는다.
단, 종료 상태도 회의일·attempt·depth와 필수 증거 검증을 먼저 통과해야 한다. `published`는
보고서·스냅샷·생성 run의 해시와 소유권을 다시 확인하고, `failed`는 같은 회의·attempt의
장애 JSON/Markdown 쌍과 기록 내용이 일치해야 한다.
손상된 종료 상태는 `terminal_state_invalid`로 오류 종료하고 래퍼가 알림을 남긴다. 소유권을
신뢰할 수 없는 `status.json`은 덮어쓰지 않으며, FAIL 로그가 해당 원본 경로를 가리킨다.

`serverState=unchanged`는 Wiki 쓰기가 확인되지 않았다는 뜻이다. `written_unverified`는 PUT 또는
다른 Redmine 쓰기가 적용됐을 수 있으나 후속 GET의 정확한 섹션 일치를 확인하지 못했다는
뜻이고, 자동 rollback이나 재게시는 하지 않는다. `verified`는 서버 섹션과 고정한 hash가 일치한
경우다. `redmineWriteAttempted`는 외부 쓰기 경계를 넘었는지를 별도로 나타낸다.

수동 복구는 호출자가 지정한 `MEETING_DATE`, `OUTPUT_DIR`, `SNAPSHOT_PATH`를 보존한다.

```bash
rtk env MEETING_DATE=2026-09-16 ./run-weekly-prepare-env.sh
rtk env MEETING_DATE=2026-09-16 ./run-weekly-publish-env.sh
```

`publishing`에서 중단된 상태는 서버가 이미 바뀌었을 수 있는 stale 상태다. 먼저 Redmine Wiki와
발표노트 Issue를 직접 확인한 다음 새 prepare attempt를 시작해야 하며, 기존 attempt를 자동으로
이어 게시하지 않는다. 검증 실패도 canonical 보고서로 승격하거나 Redmine을 변경하지 않는다.
대신 run 아래의 provider 원본 `draft.ai.annotated.md`, 수동 복구용
`draft.working.annotated.md`, `report.rejected.NNN.md`, `validation.NNN.json`과 파이프라인 장애
JSON/Markdown을 모두 유지한다.

Mode boundaries
- `collect`: Git/Notion/session을 조회하고 sealed snapshot만 저장. AI/Redmine 쓰기 없음.
- `generate`: 기존 sealed snapshot만 읽음. 수집하지 않고 AI 요약·사실 검증 후 depth 파일 저장. `AI_SUMMARIZE=1`이면 schema v2, `AI_SUMMARIZE=0`이면 기존 schema v1.
- `revalidate`: 지정한 실패 schema v2 run의 working draft를 Claude 호출 없이 재검증. Redmine 쓰기 없음.
- `update`: 수집/AI 호출 없음. snapshot과 depth 파일을 재검증한 후 Redmine 반영.

`AI_GENERATION_SCOPE=whole`은 기존처럼 보고서 전체를 한 번 호출한다. `project`는 내용이 있는
PIM → Wireless Lan → ETC만 각각 순차 호출하며, 한 파트의 차단 검증이 실패하면 뒤의 호출을
중단한다. 파트 결과는 설정 순서로 결정적으로 병합하고 기존 전체 schema v2 검증을 다시 통과해야 한다.
평소 작업량에는 기본값 `whole`을 유지하고, 입력이 큰 주에만 `project`를 선택한다.
`project`는 파트별 사실-대상·section 검증에 더 민감하므로 현재는 큰 입력을 위한 파일럿 옵션이다.
파트 실패 시 해당 원문과 오류를 보존하고 뒤 파트는 호출하지 않는다.

Claude는 `--safe-mode --tools "" --no-session-persistence`, Codex는 격리된 임시 작업 디렉터리와
`--ephemeral --ignore-user-config --ignore-rules --sandbox read-only`로 실행한다. 두 provider 모두
프로젝트 plugin·hook·MCP와 사용자 전역 model/effort를 불러오지 않는다. provider 자동 fallback과
실패 재호출은 하지 않는다. AI가 활성화된
상태에서 입력 상한, quota, timeout, CLI 실행 또는 빈 응답 오류가 발생하면 `generate`를 실패시키고
raw 초안으로 대체하지 않는다. `update`는 기존처럼 별도 실행이지만 실패한 generate 뒤에는 게시 단계로 진행하지 않는다.
AI-enabled schema v2 generate는 시도별 자료를 `out/runs/<date>/<run-id>/`에 저장한다.
schema v2 generate 시작 전에는 90일이 지난 `ai_failed`·`complete`·`validation_failed` run을 자동 정리한다.
실행 중이거나 validation lock이 사용 중인 run, 비정상 경로·state 소유권, 심볼릭 링크는 삭제하지 않는다.
실제 삭제는 validation lock을 끝까지 보유하고 검증된 날짜 디렉터리 아래에서 inode가 일치하는
격리 run만 제거한다.
정리 오류는 경고로 남기되 generate의 성공 여부를 바꾸지 않는다. 운영자가 정리 대상을 먼저
확인할 때는 `MODE=prune` dry-run을 사용하고, 실제 삭제는 `PRUNE_APPLY=1`을 함께 지정한다.
schema v2 프롬프트는 원문의 보호 사실을 `[[fact:T0001]]` 같은 값 없는 인라인 reference로
치환한다. Claude는 reference만 복사하고, 응답 직후 코드가 catalog의 원문 표기를 채워
`[[fact:T0001|5/8 PASS]]` full marker로 결정적으로 확장한다. 따라서 별도 sourceExcerpt catalog를
프롬프트에 중복하지 않으며 Claude가 보호 숫자·단위를 직접 다시 쓸 필요가 없다.
Claude가 reference를 누락하고 `aarch64`처럼 영문과 숫자가 섞인 식별자를 원문 표기 그대로 쓴
경우에는 코드가 full marker를 복원한다. 같은 표기가 catalog에 한 번만 있거나, 중복 표기 중
출력 줄과 `sourceExcerpt`의 문맥 토큰이 2개 이상 일치하는 유일한 후보가 있을 때만 복원한다.
동점·문맥 부족은 계속 검증 실패로 남기며, 수량·날짜·버전·PASS/FAIL·단위는 자동 복원하지 않는다.
`V4L2`, `v2ray`처럼 `v` 다음에 숫자가 오는 토큰은 기술 ID와 버전을 문자열만으로 구분할 수
없으므로 모두 자동 복원에서 제외하고 기존 검증기가 fail-closed한다.
`draft.ai.annotated.md`는 bare reference가 포함될 수 있는 Claude 원본이므로 수정하지 않고,
복구할 때는 full marker로 확장된 `draft.working.annotated.md`만 수정한다.
`MODE=revalidate`는 같은 run에 `validation.NNN.json` revision을 새로 추가하며 Claude를 호출하지 않는다.
검증 성공 시 marker가 제거된 `report.clean.md`만 canonical depth 보고서로 원자적으로 승격된다.
schema v2 clean 보고서를 직접 편집하면 update가 Redmine 요청 전에 hash 불일치로 중단하며,
사실 marker·snapshot·catalog·validation·clean-report hash 오류는 `VALIDATION_OVERRIDE=1`로도 우회할 수 없다.
각 generate 시도는 `.generation.json`을 먼저 `running`으로 기록하고 모든 생성·검증이 끝나야
`complete`로 바꾼다. `update`는 동일 meeting date·depth·snapshot hash의 `complete` 증거가 없으면
Redmine API 호출 전에 중단하므로, 같은 날짜의 이전 초안이 남아 있어도 실패한 시도 뒤에 게시하지 않는다.
cron wrapper는 `out/report-run.lock`의 비차단 `flock`을 사용한다. 이전 collect/generate/update가
끝나지 않았으면 겹쳐 실행하지 않고 exit 75로 실패·알림 처리한다.

Artifacts
- `out/report-YYYY-MM-DD.snapshot.json`: 수집 원본, 범위, source 상태, content hash를 포함한 sealed snapshot
- `out/presentation-candidates-YYYY-MM-DD.json`: 발표노트 태그·자동 후보와 판정 근거
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.md`: depth별 초안
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.generation.json`: generate 시도 상태와 snapshot 결속 정보
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.validation.json`: snapshot/report hash와 사실검증 결과
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.published.md`: Redmine에 실제 반영한 최종 조현우 섹션
- `out/runs/YYYY-MM-DD/<run-id>/state.json`: schema v2 시도 상태와 최신 validation revision 소유권
- `out/runs/YYYY-MM-DD/<run-id>/fact-catalog.json`: 원본에서 추출한 exact-copy 사실 catalog
- `out/runs/YYYY-MM-DD/<run-id>/source-coverage.json`: 필수 source coverage catalog. 내용이 있는 설정 기반 section과 모든 `[Notion]` 입력 항목의 canonical path, ID, `coverageCatalogHash`를 보관
- `out/runs/YYYY-MM-DD/<run-id>/prompt-input.json`: snapshot/catalog/prompt/model과 fact input mode 입력 증거
- `out/runs/YYYY-MM-DD/<run-id>/draft.ai.annotated.md`: bare fact reference가 포함될 수 있는 변경 금지 AI 원본 출력
- `out/runs/YYYY-MM-DD/<run-id>/draft.ai.part.NNN.annotated.md`: `project` 모드의 파트별 변경 금지 AI 원본 출력. 중간 실패 시에도 완료된 파트까지 보존
- `out/runs/YYYY-MM-DD/<run-id>/draft.working.annotated.md`: full marker로 확장된 실패 run 수동 복구 대상
- `out/runs/YYYY-MM-DD/<run-id>/validation.NNN.json`: 덮어쓰지 않고 추가되는 검증 revision
- `out/runs/YYYY-MM-DD/<run-id>/report.rejected.NNN.md`: validation revision `NNN`이 실패했을 때 marker를 제거해 보존하는 로컬 전용 생성물. 정식 초안 경로가 아니며 `MODE=update` 게시 대상이 아님
- `out/runs/YYYY-MM-DD/<run-id>/report.clean.md`: marker가 제거된 검증 성공 보고서

Source coverage contract (schema v2)
- `source-coverage.json`의 `C0001` 같은 `C` marker는 내용이 있는 설정 기반 **section heading**을 뜻한다. 해당 heading은 catalog의 canonical category path에 정확히 한 번 존재해야 한다.
- `N0001` 같은 `N` marker는 입력의 각 `[Notion]` bullet을 뜻한다. 요약에 남긴 Notion 항목은 marker를 원래 canonical path 안에 유지한다. 요약에서 제외된 item의 누락과 같은 path 안의 중복은 coverage warning/지표로 남지만 publish를 차단하지 않는다.
- populated configured section의 누락·중복·잘못된 heading/path는 차단한다. unknown/malformed marker와 `N` marker의 다른 category 이동도 계속 차단한다.
- coverage 적용 run은 `state.json`, 전역 `*.generation.json`, `prompt-input.json`, `validation.NNN.json`에 `sourceCoverageMode: "required_sections_notion_advisory_v2"`와 동일한 `coverageCatalogHash`를 기록한다. revalidate와 update는 이 값과 `source-coverage.json`의 hash 소유권을 대조한다.
- coverage validation이 실패하면 같은 generate run에서 Claude를 다시 호출하지 않는다. `draft.ai.annotated.md`는 immutable 원본으로 남기고, marker 없는 실패본은 `report.rejected.NNN.md`로 보존한다. 실패 상태에서는 정식 `jo-hyunwoo-*.md`를 생성·교체하지 않으므로 `MODE=update` 게시도 차단된다. 운영자는 **`draft.working.annotated.md`만** 수동 수정한 다음 `MODE=revalidate RUN_ID=<uuid>`를 실행한다.
- generate는 누락 `C` marker를 유일한 exact canonical heading에만 붙인다. 유일한 `C` marker가
  leaf heading 이름만 바꿨다면 부모 path와 들여쓰기가 원본과 일치할 때만 fact-annotated canonical
  heading으로 복원한다. 단, 교체할 heading 줄에 보호 사실이나 fact/source-like marker가 하나라도
  있으면 내용을 지우지 않고 정규화를 거부한다. 유일한 예외는 C marker가 줄 끝에 있고 leaf 전체가
  다른 configured canonical leaf와 정확히 일치하는 명백한 section-name 전치다. 결과는 run
  `state.json`의 `sourceCoverageNormalization`에 기록한다.
- 누락 `N` marker의 원문 bullet은 자동으로 덧붙이지 않는다. source normalization 뒤에도 원본
  없는 보호 사실과 open-status 검증 실패는 그대로 publish를 차단한다.
- coverage catalog/hash/validation ownership이 없거나 일치하지 않으면 `MODE=update`는 Redmine API 요청 전에 실패한다. 이 coverage-specific failure는 `VALIDATION_OVERRIDE=1`로 우회할 수 없다.

Pilot and publication approval
- 로컬 fake CLI/server 회귀 테스트는 실제 Claude 호출이나 Redmine 게시가 아니다. 실제 Claude pilot과 실제 Redmine publication은 각각 별도의 명시적 승인을 받은 뒤에만 실행한다.

Current cron flow before the two-wrapper rollout (Wednesday, Asia/Seoul)
- 06:05 `collect`
- 06:15 depth3 `generate`
- 06:30 depth2 `generate`
- 06:45 depth3 `update` (`VALIDATION_MODE=block`, `PRESENTATION_NOTE_MODE=suggest`)

Approval flow
- The script prints the current section content and the updated section content, then asks for confirmation.
- Type `y` to apply; anything else cancels.
