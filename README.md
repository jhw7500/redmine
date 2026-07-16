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
- `MODE` (`collect`=수집 snapshot 생성, `generate`=snapshot에서 depth 파일 생성, `update`=검증된 파일을 Redmine에 반영)
- `REPORT_DEPTH` (default: 2 — 보고서 상세도. 1=요약, 2=표준, 3=중간, 4=상세. repo-config.json `defaults.reportDepth`/`depthProfiles` 참조)
- `SNAPSHOT_PATH` (default: `OUTPUT_DIR/report-YYYY-MM-DD.snapshot.json`)
- `FORCE_COLLECT` (`1`이면 sealed snapshot을 재수집. 원본이 바뀌면 기존 snapshot을 hash 이름으로 보존)
- `ALLOW_PARTIAL_SNAPSHOT` (`1`이면 일부 source 수집 실패 snapshot도 generate/update에 사용)
- `VALIDATION_MODE` (`block` 기본, `warn`이면 사실 검증 실패를 경고하고 update 계속)
- `VALIDATION_OVERRIDE` (`1`이면 검증 실패를 명시적으로 수동 우회)
- `PRESENTATION_NOTE_MODE` (`tagged` 기본. `suggest`=자동 후보 기록+명시 태그만 게시, `auto`=자동 후보도 게시, `off`=비활성)
- `PRESENTATION_NOTE_THRESHOLD` (자동 발표노트 후보 점수, 기본 5)
- `LEADER_HIGHLIGHT` (default: 0 — 팀장 회의 보고용 중요 항목 밑줄(`<u>`) 강조. 1=사용. repo-config.json `reportFilter.leaderHighlight.enabled`보다 우선)
- `LEADER_HIGHLIGHT_MAX` (default: 0 = 무제한 — 밑줄 최대 줄 수. N>0이면 AI에 상한 지시. repo-config.json `reportFilter.leaderHighlight.maxLines`보다 우선)
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
- Update from validated file: `MODE=update REPORT_DEPTH=3 MEETING_DATE=2026-07-15 ./run-report-env.sh`
- Depth 비교 테스트: 먼저 `MODE=collect ./run-report-env.sh` 실행 후 `./run-depth-test.sh` — 동일 sealed snapshot으로 depth 1/2/3/4 생성·검증

Mode boundaries
- `collect`: Git/Notion/session을 조회하고 sealed snapshot만 저장. AI/Redmine 쓰기 없음.
- `generate`: 기존 sealed snapshot만 읽음. 수집하지 않고 AI 요약·사실 검증 후 depth 파일 저장.
- `update`: 수집/AI 호출 없음. snapshot과 depth 파일을 재검증한 후 Redmine 반영.

Artifacts
- `out/report-YYYY-MM-DD.snapshot.json`: 수집 원본, 범위, source 상태, content hash를 포함한 sealed snapshot
- `out/presentation-candidates-YYYY-MM-DD.json`: 발표노트 태그·자동 후보와 판정 근거
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.md`: depth별 초안
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.validation.json`: snapshot/report hash와 사실검증 결과
- `out/jo-hyunwoo-YYYY-MM-DD.depthN.published.md`: Redmine에 실제 반영한 최종 조현우 섹션

Current cron flow (Wednesday, Asia/Seoul)
- 06:05 `collect`
- 06:15 depth3 `generate`
- 06:30 depth2 `generate`
- 06:45 depth3 `update` (`VALIDATION_MODE=block`, `PRESENTATION_NOTE_MODE=suggest`)

Approval flow
- The script prints the current section content and the updated section content, then asks for confirmation.
- Type `y` to apply; anything else cancels.
