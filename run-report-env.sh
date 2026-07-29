#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/jhw/ai/opencode/projects/redmine
_requested_mode="${MODE:-}"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -n "$_requested_mode" ]]; then
  export MODE="$_requested_mode"
else
  export MODE="${MODE:-generate}"
fi
unset _requested_mode

# NOTION_API_KEY는 ~/.bashrc를 single source of truth로 사용한다.
if [[ -z "${NOTION_API_KEY:-}" && -f "$HOME/.bashrc" ]]; then
  _notion_line=$(grep -E '^[[:space:]]*export[[:space:]]+NOTION_API_KEY=' "$HOME/.bashrc" | tail -1 || true)
  if [[ -n "$_notion_line" ]]; then
    eval "$_notion_line"
    export NOTION_API_KEY
  fi
  unset _notion_line
fi

export TZ=Asia/Seoul
export PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:/home/jhw/.local/bin:$PATH"

# cron 실행은 실패해도 아무도 모른 채 지나간다 (2026-07-22·07-29 게시가 2주 연속
# 조용히 누락된 원인). 실패를 반드시 눈에 띄게 남긴다.
set +e
node "$ROOT/index.js"
status=$?
set -e

if [[ $status -ne 0 ]]; then
  alert="[ALERT] $(date '+%F %T') redmine 보고 실패 — MODE=${MODE} exit=${status} (로그: $ROOT/out/cron.log)"
  # set -e 상태이므로 알림 실패(디스크 풀 등)가 exit $status 도달을 막지 않게 한다.
  echo "$alert" >&2 || true
  printf '%s\n' "$alert" >> "$ROOT/out/ALERT.log" || true
  # 데스크톱 알림은 best-effort — cron에는 세션 버스가 없을 수 있으므로 실패를 무시한다.
  DISPLAY="${DISPLAY:-:0}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
    notify-send -u critical "Redmine 보고 실패" "MODE=${MODE} exit=${status}" >/dev/null 2>&1 || true
fi

exit $status
