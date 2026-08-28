Redmine weekly meeting automation (조현우 section) - API

Setup
- Uses Node 18+ (built-in fetch)
- Set credentials via env vars.

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
- `AI_SUMMARIZE` (`1`이면 generate 단계에서 Claude 요약 사용. 미설정 시 원본 초안 사용)
- `AI_MODEL` (default: `sonnet` — 주간보고 전용 모델. 사용자 전역 모델을 상속하지 않음)
- `AI_EFFORT` (default: `low`; `low|medium|high|xhigh|max`)
- `AI_MAX_INPUT_CHARS` (default: `100000` — Claude에 전달할 전체 prompt 문자 수 상한. 초과 시 호출 전 중단)
- `AI_TIMEOUT_MS` (default: `300000` — Claude 단일 호출 timeout, 양의 정수)
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
- Revalidate a failed AI run without Claude: `MODE=revalidate RUN_ID=<uuid> MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Update from validated file: `MODE=update REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Preview expired run cleanup: `MODE=prune ./run-report-env.sh`
- Apply expired run cleanup: `MODE=prune PRUNE_APPLY=1 ./run-report-env.sh`
- Depth 비교 테스트: 먼저 `MODE=collect ./run-report-env.sh` 실행 후 `./run-depth-test.sh` — 동일 sealed snapshot으로 depth 1/2/3/4 생성·검증

Mode boundaries
- `collect`: Git/Notion/session을 조회하고 sealed snapshot만 저장. AI/Redmine 쓰기 없음.
- `generate`: 기존 sealed snapshot만 읽음. 수집하지 않고 AI 요약·사실 검증 후 depth 파일 저장. `AI_SUMMARIZE=1`이면 schema v2, `AI_SUMMARIZE=0`이면 기존 schema v1.
- `revalidate`: 지정한 실패 schema v2 run의 working draft를 Claude 호출 없이 재검증. Redmine 쓰기 없음.
- `update`: 수집/AI 호출 없음. snapshot과 depth 파일을 재검증한 후 Redmine 반영.

AI 요약은 호출당 1회로 고정하며 `--safe-mode --tools "" --no-session-persistence`로 실행한다.
따라서 프로젝트 plugin·hook·MCP와 사용자 전역 모델/effort를 불러오지 않는다. AI가 활성화된
상태에서 입력 상한, quota, timeout, CLI 실행 또는 빈 응답 오류가 발생하면 `generate`를 실패시키고
raw 초안으로 대체하지 않는다. `update`는 기존처럼 별도 실행이지만 실패한 generate 뒤에는 게시 단계로 진행하지 않는다.
AI-enabled schema v2 generate는 시도별 자료를 `out/runs/<date>/<run-id>/`에 저장한다.
schema v2 generate 시작 전에는 90일이 지난 `complete`·`validation_failed` run을 자동 정리한다.
실행 중이거나 validation lock이 사용 중인 run, 비정상 경로·state, 심볼릭 링크는 삭제하지 않는다.
정리 오류는 경고로 남기되 generate의 성공 여부를 바꾸지 않는다. 운영자가 정리 대상을 먼저
확인할 때는 `MODE=prune` dry-run을 사용하고, 실제 삭제는 `PRUNE_APPLY=1`을 함께 지정한다.
schema v2 프롬프트는 원문의 보호 사실을 `[[fact:T0001]]` 같은 값 없는 인라인 reference로
치환한다. Claude는 reference만 복사하고, 응답 직후 코드가 catalog의 원문 표기를 채워
`[[fact:T0001|5/8 PASS]]` full marker로 결정적으로 확장한다. 따라서 별도 sourceExcerpt catalog를
프롬프트에 중복하지 않으며 Claude가 보호 숫자·단위를 직접 다시 쓸 필요가 없다.
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
- `out/runs/YYYY-MM-DD/<run-id>/prompt-input.json`: snapshot/catalog/prompt/model과 fact input mode 입력 증거
- `out/runs/YYYY-MM-DD/<run-id>/draft.ai.annotated.md`: bare fact reference가 포함될 수 있는 변경 금지 Claude 원본 출력
- `out/runs/YYYY-MM-DD/<run-id>/draft.working.annotated.md`: full marker로 확장된 실패 run 수동 복구 대상
- `out/runs/YYYY-MM-DD/<run-id>/validation.NNN.json`: 덮어쓰지 않고 추가되는 검증 revision
- `out/runs/YYYY-MM-DD/<run-id>/report.clean.md`: marker가 제거된 검증 성공 보고서

Current cron flow (Wednesday, Asia/Seoul)
- 06:05 `collect`
- 06:15 depth3 `generate`
- 06:30 depth2 `generate`
- 06:45 depth3 `update` (`VALIDATION_MODE=block`, `PRESENTATION_NOTE_MODE=suggest`)

Approval flow
- The script prints the current section content and the updated section content, then asks for confirmation.
- Type `y` to apply; anything else cancels.
