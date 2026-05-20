# AGENTS.md — redmine 주간 보고 자동화

> 워크스페이스 공통 규칙은 `../../AGENTS.md`, `../../CLAUDE.md` 참조.
> 이 파일은 **이 프로젝트로 보고서를 만들 때의 고유 규율**만 담는다.

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

## (참고) 후속 대책 — 다른 repo, 별도 적용 필요

- **personal-ops `session-summary.sh`**: "### 미완료 항목"에 resolution back-link 추적 — 직전 미완료 항목이 후속 커밋으로 닫히면 다음 요약에 `[resolved by <commit>]` 표기. → 1번 규칙의 수작업 대조를 데이터 소스 단에서 줄임.
- **gstApp `json_get_int_array`**: 길이 불일치 시 silent `keep defaults`(→ 4096 고정 같은 무증상 설정 무시)를 **시작 시 치명 설정오류로 집계·노출**. + 매직 길이(`MAX_MODE`) 금지·배열에서 파생 + 길이 회귀 단위테스트.
