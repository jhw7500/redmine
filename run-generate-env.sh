#!/usr/bin/env bash
set -euo pipefail

if [[ -f /home/jhw/ai/opencode/projects/redmine/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/jhw/ai/opencode/projects/redmine/.env
  set +a
fi

export MODE="${MODE:-generate}"
export PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:/home/jhw/.local/bin:$PATH"
node /home/jhw/ai/opencode/projects/redmine/index.js
