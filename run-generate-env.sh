#!/usr/bin/env bash
set -euo pipefail

if [[ -f /home/jhw/ai/opencode/projects/redmine/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/jhw/ai/opencode/projects/redmine/.env
  set +a
fi

# NOTION_API_KEY 는 ~/.bashrc 를 single source of truth 로 사용 (다른 셸 환경과 동기화).
# bashrc 전체를 source 하지 않고 NOTION_API_KEY 라인만 안전하게 추출한다.
if [[ -z "${NOTION_API_KEY:-}" && -f "$HOME/.bashrc" ]]; then
  _notion_line=$(grep -E '^[[:space:]]*export[[:space:]]+NOTION_API_KEY=' "$HOME/.bashrc" | tail -1 || true)
  if [[ -n "$_notion_line" ]]; then
    eval "$_notion_line"
    export NOTION_API_KEY
  fi
  unset _notion_line
fi

export MODE="${MODE:-generate}"
export PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:/home/jhw/.local/bin:$PATH"
node /home/jhw/ai/opencode/projects/redmine/index.js
