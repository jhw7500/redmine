#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'usage: run-weekly-pair-env.sh prepare [codex|claude] | preview | publish [2|3] | send' >&2
  exit 64
}

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
STATUS_CLI="$ROOT/scripts/weekly-selection-status.js"
# OUTPUT_DIR 을 직접 준 실행은 호출자가 경로를 통제하는 것이다.
# 그런 실행에는 우회도 포인터도 적용하지 않는다.
explicit_output_dir=${OUTPUT_DIR+x}
base_output_dir="${OUTPUT_DIR:-$ROOT/out}"
publish_depth=2
stage=${1:-}
stage_mode="weekly-pair-$stage"

run_stage() { # $1=profile  $2=output_dir (비면 기본값)
  (
    export REDMINE_WEEKLY_PROFILE="$1"
    export MODE="$stage_mode"
    export WEEKLY_PUBLISH_DEPTH="$publish_depth"
    if [[ -n ${2:-} ]]; then export OUTPUT_DIR="$2"; fi
    "$ROOT/run-report-env.sh"
  )
}

selection_status_of() { # $1=output_dir → exit 0=AI 채택 10=쿼터 11=기타
  set +e
  node "$STATUS_CLI" status "$1" "$publish_depth" >/dev/null
  local code=$?
  set -e
  return $code
}

active_output_dir() {
  [[ -n $explicit_output_dir ]] && return 0
  node "$STATUS_CLI" active-dir "$base_output_dir" 2>/dev/null || true
}

case $stage in
  prepare)
    [[ $# -le 2 ]] || usage
    provider=${2-codex}
    case $provider in
      codex) profile=prepare ;;
      claude) profile=prepare-claude ;;
      *) usage ;;
    esac
    run_stage "$profile"
    # provider 를 명시한 실행과 OUTPUT_DIR 을 준 실행은 그대로 둔다.
    # 기본 실행에서 쿼터로 AI 선택이 비었을 때만 1회 우회한다.
    if [[ $# -eq 1 && -z $explicit_output_dir ]]; then
      selection_code=0
      selection_status_of "$base_output_dir" || selection_code=$?
      if [[ $selection_code -eq 10 ]]; then
        fallback_dir="$base_output_dir/provider-fallback/$(date -u +%Y%m%dT%H%M%SZ)"
        echo "[pair] codex 쿼터로 AI 선택이 비었다 — claude 로 1회 우회한다: $fallback_dir" >&2
        fallback_code=0
        run_stage prepare-claude "$fallback_dir" || fallback_code=$?
        fallback_selection=1
        if [[ $fallback_code -eq 0 ]]; then
          fallback_selection=0
          selection_status_of "$fallback_dir" || fallback_selection=$?
        fi
        if [[ $fallback_code -eq 0 && $fallback_selection -eq 0 ]]; then
          node -e '
const {writeActiveOutputDir,readWeeklySelectionStatus} = require(process.argv[1]);
const [, , dir, base, depth] = process.argv;
const status = readWeeklySelectionStatus(dir,{depth:Number(depth)});
writeActiveOutputDir(base,{meetingDate:status.meetingDate,outputDir:dir});
' "$ROOT/lib/weekly-selection-status.js" "$fallback_dir" "$base_output_dir" "$publish_depth"
          echo "[pair] 우회 성공 — 이후 publish/send 는 $fallback_dir 를 쓴다" >&2
        else
          echo "[pair] 우회로도 AI 선택을 얻지 못했다 — 기본 산출물로 진행한다" >&2
        fi
      fi
    fi
    ;;
  preview|send)
    [[ $# -eq 1 ]] || usage
    run_stage publish "$(active_output_dir)"
    ;;
  publish)
    [[ $# -le 2 ]] || usage
    case ${2:-2} in
      2|3) publish_depth=${2:-2} ;;
      *) usage ;;
    esac
    run_stage publish "$(active_output_dir)"
    ;;
  *) usage ;;
esac
