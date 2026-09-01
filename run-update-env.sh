#!/usr/bin/env bash
set -euo pipefail

export MODE=update
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$ROOT/run-report-env.sh"
