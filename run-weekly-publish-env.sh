#!/usr/bin/env bash
set -euo pipefail

export MODE=weekly-publish
export REDMINE_WEEKLY_PROFILE=publish
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$ROOT/run-report-env.sh"
