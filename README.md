Redmine weekly meeting automation (조현우 section) - API

Setup
- Uses Node 18+ (built-in fetch)
- Set credentials via env vars.

Required env vars
- `REDMINE_API_KEY`

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
- `OUTPUT_PATH` (default: OUTPUT_DIR/jo-hyunwoo-YYYY-MM-DD.md)
- `MODE` (default: generate, set to update to push to Redmine)
- `REPORT_DEPTH` (default: 2 — 보고서 상세도. 1=요약, 2=표준, 3=상세. repo-config.json `defaults.reportDepth`/`depthProfiles` 참조)
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
- Workflow 요약은 핵심 항목만 출력하며, 한글에서도 'workflow'를 그대로 사용합니다.
- `GITHUB_TOKEN`이 있으면 PR 제목/본문 요약을 자동으로 채웁니다.

Run
- Draft only (write file): `MODE=generate node redmine-auto/update-jo-hyunwoo.api.js`
- Update from file: `MODE=update node redmine-auto/update-jo-hyunwoo.api.js`
- Depth 비교 테스트: `./run-depth-test.sh` — 1회 수집으로 depth 1/2/3 요약을 `out/jo-hyunwoo-YYYY-MM-DD.depthN.md`에 생성 (원본 보고서는 유지)

Approval flow
- The script prints the current section content and the updated section content, then asks for confirmation.
- Type `y` to apply; anything else cancels.
