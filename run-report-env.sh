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
exec node "$ROOT/index.js"
