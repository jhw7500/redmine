#!/usr/bin/env bash
set -euo pipefail

if [[ -f /home/jhw/ai/opencode/projects/redmine/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/jhw/ai/opencode/projects/redmine/.env
  set +a
fi

export MODE=generate
node /home/jhw/ai/opencode/projects/redmine/update-jo-hyunwoo.api.js
