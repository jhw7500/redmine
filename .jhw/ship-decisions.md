# ship 결정 기록

자동 리뷰어 지적 중 **반려**했거나 **이미 해결됨**으로 판정한 항목을 남긴다.
다음 라운드에 같은 지적이 재등장해도 다시 블로킹하지 않기 위한 근거다.

---

## PR #9 — fix(report): 검증 오탐·WARNING 차단으로 막힌 Redmine 게시 복구

### [declined] Codex P1 — `open_status_pickaxe_unavailable`을 게시 차단으로 유지하라

- **위치**: `index.js` — `NON_BLOCKING_WARNING_CODES`
- **지적**: 코드 심볼이 없는 미해결 주장은 pickaxe 2차 검증이 불가능한 케이스이므로,
  명시적 수동 확인이 기록되지 않는 한 게시를 차단해야 한다. 근거는 `AGENTS.md:18-22`의
  실제 사고(2026-05-20 gstApp — fix가 `chore:` 제목에 번들돼 title check로는 잡히지 않음).
- **결정**: 반려 (2026-07-29, 저장소 소유자 판단)
- **근거**:
  - title check는 계속 수행되며, 해결 흔적이 실제로 발견되면
    `open_status_resolution_evidence`로 여전히 차단된다.
  - 차단을 유지하면 문구 수정으로 제거할 수 없는 이 경고 하나 때문에 주간 게시가
    영구 중단된다. 2026-07-22·07-29 2주 연속 누락이 그 결과였다.
  - 대신 이번 PR에서 `ALERT.log` + `notify-send` 알림과 비차단 경고의 코드 로깅을
    추가해, 경고가 조용히 묻히지 않도록 했다.
- **함께 유지되는 차단**: `open_status_resolution_evidence`,
  `open_status_git_check_failed`, `open_status_git_pickaxe_failed`, 그리고 허용목록에
  없는 모든 신규 warning 코드.

### [stale] Codex P2 — `generate`가 non-PASS를 exit 2로 처리해 헛알림

- 라운드 1(`ed5c3ce`) 지적이며 `b2bd4ef`에서 `isPublishable`로 generate/update 기준을
  단일화해 해결했다. 라운드 2에 같은 코멘트가 재게시됐으나 그 시점에 이미 해결된 상태였다.
- Codex는 push(synchronize)로 재리뷰하지 않고 PR 생성/`@codex review` 코멘트로만
  트리거된다. 재푸시 후 유효한 Codex 라운드를 얻으려면 `@codex review`를 남겨야 한다.

### [out-of-scope] Gemini MEDIUM — `PATH`에 node 경로·버전 하드코딩

- `run-report-env.sh:33`은 이 PR의 diff 범위 밖(기존 코드)이다. 해당 경로에 node가
  존재하고 fallback PATH도 있어 당장 동작에 문제는 없다. 별도 작업으로 다룬다.

### [known-limitation] 원본에 같은 조수사 토큰이 있으면 센 대상을 대조하지 않는다

- 예: 원본 `3건의 검사`, 보고서 `3건의 검토` → PASS. 원본에 `3건` 토큰이 있어
  조수사 예외 경로 이전 단계에서 통과한다.
- main 브랜치에서도 동일하게 PASS이므로 이 PR이 만든 문제가 아니다.
  protected token 대조 자체를 명사 단위로 바꾸는 것은 별도 범위.
