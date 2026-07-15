#!/usr/bin/env bash
set -euo pipefail

export MODE="${MODE:-generate}"
exec /home/jhw/ai/opencode/projects/redmine/run-report-env.sh
