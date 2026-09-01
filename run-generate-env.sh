#!/usr/bin/env bash
set -euo pipefail

export MODE="${MODE:-generate}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$ROOT/run-report-env.sh"
