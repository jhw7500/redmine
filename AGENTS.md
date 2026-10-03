# AGENTS.md — redmine 주간 보고 자동화

> 워크스페이스 공통 규칙(코딩 스타일·에러 처리·의존성·git 위생)은 `../../AGENTS.md`, `../../CLAUDE.md` 참조.
> 이 파일은 Claude Code와 Codex가 **공용으로 읽는 이 저장소의 정본 지침**이다. 루트 `CLAUDE.md`는 `@AGENTS.md` import 셔임이므로 지침은 여기에만 적는다.

## 프로젝트 개요

Redmine 위키의 선행개발팀 주간 회의 페이지에 조현우 섹션을 자동 생성·게시하는 Node 18+ 도구.
git 커밋/PR·Notion KB·세션 요약을 수집 → AI로 보고서 초안 생성 → 사실 검증 → Redmine 반영. 상세 설정은 `README.md`, AI 생성 운용은 `docs/ai-generation-usage.md`.

| 경로 | 역할 |
|---|---|
| `index.js` | 진입점. `MODE` 환경변수로 동작 분기 |
| `lib/` | 수집(`collector.js`, `notion-*.js`), 선택(`source-selection*.js`), 검증(`fact-*.js`, `open-issue-verifier.js`), 게시(`publisher.js`, `weekly-pipeline.js`) |
| `lib/__tests__/` | `node --test` 테스트 (`*.test.js`, 공용 fixture는 `helpers/`) |
| `run-*-env.sh` | `.env`를 읽어 `index.js`를 특정 `MODE`로 실행하는 래퍼 (cron도 이 경로) |
| `scripts/` | 보조 도구 (잠금 `run-with-lock.sh`, 재생 `replay-source-selection.js`, 알림 `redmine-alert.sh`) |
| `repo-config.json` | 수집 대상 repo 목록·depth 프로파일. `repos[].path`가 로컬 체크아웃 경로 |
| `templates/` | 섹션/페이지 Markdown 템플릿 |
| `docs/` | `superpowers/specs/`·`superpowers/plans/`(설계·계획), `01-plan`~`04-report`(산출물) |
| `out/` | 생성 산출물·run 스냅샷·`cron.log`. git 비추적 |

## 실행 / 검증 명령 (저장소 루트에서)

```bash
# 테스트 — 전체 / 단일 파일
node --test lib/__tests__/*.test.js
node --test lib/__tests__/<name>.test.js

# 보고서 파이프라인 — MODE 별 래퍼 (.env 자동 로드)
./run-generate-env.sh            # MODE=generate: 스냅샷에서 depth 파일 생성 (서버 쓰기 없음)
./run-update-env.sh              # MODE=update : 검증된 파일을 Redmine에 게시 (서버 쓰기 있음)
./run-weekly-pair-env.sh prepare [codex|claude] | preview | publish [2|3] | send
MODE=collect|revalidate|prune ./run-report-env.sh   # 그 외 모드. prune은 PRUNE_APPLY=1 전까지 dry-run

# 발표노트 → Redmine 이슈 (단건 파일럿)
node lib/notion-issue-publisher.js --page <notionPageId> --dry-run
```

- `package.json`은 없다. `npm test`를 가정하지 말고 위 `node --test`를 쓴다.
- 코드 변경 후에는 전체 테스트를 돌리고 **실행/실패/skip 수**를 보고한다. 통과 문자열이나 exit 0만으로 판정하지 않는다.

## 안전 경계

- **서버에 쓰는 모드**(`MODE=update`, `weekly-publish`, `run-weekly-pair-env.sh publish|send`, `--dry-run` 없는 `notion-issue-publisher.js`)는 사용자 승인 후에만 실행한다. 코드 수정·테스트 승인은 게시 승인이 아니다.
- `.env`(`REDMINE_API_KEY`, `NOTION_API_KEY` 등)는 커밋 금지. 로그·예시·이슈 본문에 값을 옮기지 않는다.
- `out/`은 지우거나 재생성하기 전에 내용을 본다. run 스냅샷은 `MODE=prune`의 보존 규칙(`RUN_ARTIFACT_RETENTION_DAYS`)을 따른다.
- cron이 같은 래퍼를 돌린다. 래퍼·`repo-config.json`·`.env` 키를 바꾸면 다음 cron 실행에 영향이 있음을 보고에 명시한다.

## PR / 리뷰 워크플로

- PR 생성 전 **pre-pr-tribunal** 게이트가 훅으로 강제된다. 루트의 `README.md`·`repo-config.json`은 `unknown-path` risk 100(iterative)으로 실측됐고 루트의 다른 `.md`도 같은 규칙을 탄다고 보이므로, 심사 단위를 작게 나눈다. 실제 값은 커밋 후 `policy-preview --base main --runtime claude|codex`로 확인한다(작업본이 dirty하면 `WORKTREE_DIRTY`).
- `gh pr create`는 게이트가 허용하는 형식만 통과한다 — 단일 세그먼트, 절대경로 실행파일, 리다이렉션·파이프·명령치환·`--repo`·`--head` 금지:
  ```bash
  PATH=/usr/bin:/bin /usr/bin/gh pr create --base main --title "<title>" --body-file <file>
  ```
- 자동 리뷰(Claude·Gemini)는 PR에 `review:request` 라벨이 있어야 실제로 돈다. 라벨 없이는 잡이 skip되는데 워크플로우는 success로 보인다.
- 되돌릴 가능성이 있는 기능의 커밋 본문에는 `Closes #N` 대신 `Refs #N`을 쓴다. revert해도 원 커밋의 `Closes`가 머지 시 발동해 이슈를 닫는다.
- 커밋 제목은 `<type>(<scope>): <한글 요약>` — type은 `feat|fix|docs|chore`, scope는 주로 `report|security|agents|ci`.

## 보고서에 "미해결 / 미완료 / 보류 / TODO" 류 항목을 넣을 때 (필수)

**배경 (실제 사고)**: 세션 요약(`personal-ops/session-summary`)·크로스체크에서 나온 "미완료" 항목은 **그 시점의 스냅샷**이다. 이후 커밋에서 이미 해결됐을 수 있다.
- 2026-05-20, `gstApp` bps=4096 고정 버그를 05-08/09 세션 "미완료 항목"에서 그대로 옮겨 보고서에 **"미해결"로 기재**했으나, 실제로는 **05-11(dc06098)에 수정 완료**된 상태였다. (`json_get_int_array` 길이 `MAX_MODE`→배열크기 정정)

**규칙**:
1. open-issue 문구(미해결·미완·미완료·보류·TODO·FIXME)를 보고서에 넣기 **전에, 최신 git 로그를 대조**해 해결 흔적을 확인한다.
   ```bash
   # repo 목록은 repo-config.json 의 repos[].path 참조
   # (a) 빠른 1차: 커밋 제목 grep
   node -e 'const c=require("./repo-config.json");for(const v of Object.values(c.repos))console.log(v.path)' \
     | while read r; do git -C "$r" log --since="<이슈날짜>" --oneline | grep -iE '<키워드>'; done
   # (b) 필수 2차: 코드 심볼 pickaxe — fix가 무관한 subject(chore 등)에 번들되면 (a)가 놓침
   git -C "<repo>" log -S '<코드심볼>' --oneline           # 예: -S 'arg.cam[i].bps'
   git -C "<repo>" log --since="<이슈날짜>" -p -- <파일> | grep -i '<심볼>'
   ```
   > 주의: 위 사고의 fix(dc06098, 05-11)는 제목이 `chore: 빌드 디렉토리...`라 (a)로는 안 잡혔다. 실제 확인은 (b) pickaxe로만 가능했다. **(a)만 보고 "미해결"로 단정 금지.**
2. 여전히 미해결이면 **as-of 날짜**를 붙인다 — `(YYYY-MM-DD 기준 미해결)`. 날짜 없는 "미해결"은 금지(stale 여부 판별 불가).
3. 이미 해결됐으면 이슈가 아니라 **완료 항목**으로 옮기고 수정 커밋(해시)을 명시한다.

## 발표노트 → Redmine 작업(Issue) 자동 등록

Notion KB 항목의 `tags`에 **`발표노트`** 를 붙이면, 주간 보고 게시(update)에서 해당 노트가
Redmine `advance-development-team` 프로젝트의 **작업(Issue)**으로 자동 등록되고, 조현우 섹션 말미
`**발표노트(상세)**` 블록에 `#이슈번호`로 링크된다.

- 대상: KB 항목 중 `발표노트` 태그 + 보고 기간(created_time) 내.
- 보고 depth와 무관하게 `PRESENTATION_NOTE_MODE`로 제어한다. `off`이면 생성·완료 종료를 하지 않는다.
- 본문: Notion 페이지 전체를 Markdown으로 변환해 이슈 설명에 수록.
- 중복방지: 이슈 설명의 `Notion-Page-Id: <id>` 마커로 조회 → 있으면 재사용(재생성 안 함).
- 트래커: 프로젝트 활성 트래커 중 선호순(`새기능`→`검토`), 상태 `검토`, 담당 본인.
- 수동 실행/파일럿: `node lib/notion-issue-publisher.js --page <notionPageId> [--dry-run]`
  또는 `--start YYYY-MM-DD --end YYYY-MM-DD`.
- 설계/계획: `docs/superpowers/specs|plans/2026-07-02-*presentation-note-issue*`.

## (참고) 후속 대책 — 다른 repo, 적용 완료

- **personal-ops `session-summary.sh`**: "### 미완료 항목"의 resolution back-link를 검증·추적하도록 적용 완료. 직전 미완료 항목이 후속 커밋으로 닫히면 검증된 `[resolved by <commit>]`을 기록한다. [PR #19](https://github.com/jhw7500/personal-ops/pull/19), merge `9fecfade8cd48ae004ac4b375061f214a68eacf7`.
- **gstApp 설정 배열 파서**: 잘못된 타입·길이·원소와 명시적 `null`을 채널별로 집계해 시작 전 치명 설정 오류로 노출하고, 선택 배열 누락만 기존 기본값을 유지하도록 적용 완료. 실제 파서 회귀 테스트도 추가했다. [PR #71](https://github.com/jhw7500/gstApp/pull/71), merge `a476cb64cd3b4666a03deda0b9fab2d10b33e4a0`.
