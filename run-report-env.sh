#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/jhw/ai/opencode/projects/redmine

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# NOTION_API_KEY는 ~/.bashrc를 single source of truth로 사용한다.
if [[ -z "${NOTION_API_KEY:-}" && -f "$HOME/.bashrc" ]]; then
  _notion_line=$(grep -E '^[[:space:]]*export[[:space:]]+NOTION_API_KEY=' "$HOME/.bashrc" | tail -1 || true)
  if [[ -n "$_notion_line" ]]; then
    eval "$_notion_line"
    export NOTION_API_KEY
  fi
  unset _notion_line
fi

export MODE="${MODE:-generate}"
export TZ=Asia/Seoul
export PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:/home/jhw/.local/bin:$PATH"
exec node "$ROOT/index.js"
