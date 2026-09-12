#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'usage: run-weekly-pair-env.sh prepare | preview | publish [2|3] | send' >&2
  exit 64
}

export WEEKLY_PUBLISH_DEPTH=2
case ${1:-} in
  prepare)
    [[ $# -eq 1 ]] || usage
    export REDMINE_WEEKLY_PROFILE=prepare
    ;;
  preview|send)
    [[ $# -eq 1 ]] || usage
    export REDMINE_WEEKLY_PROFILE=publish
    ;;
  publish)
    [[ $# -le 2 ]] || usage
    case ${2:-2} in
      2|3) export WEEKLY_PUBLISH_DEPTH="${2:-2}" ;;
      *) usage ;;
    esac
    export REDMINE_WEEKLY_PROFILE=publish
    ;;
  *) usage ;;
esac
export MODE="weekly-pair-$1"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$ROOT/run-report-env.sh"
