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
  # prepare 는 depth3 를 먼저 만든다. depth3 에서 검증이 막히면 depth2 는 아예
  # 생성되지 않아 판정 불가(11)가 되므로, 그때는 depth3 증거로 판정한다.
  if [[ $code -eq 11 && $publish_depth -ne 3 ]]; then
    node "$STATUS_CLI" status "$1" 3 >/dev/null
    code=$?
  fi
  set -e
  return $code
}

clear_pointer() {
  node -e '
const {clearActiveOutputDir} = require(process.argv[1]);
clearActiveOutputDir(process.argv[2]);
' "$ROOT/lib/weekly-selection-status.js" "$base_output_dir"
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
    # 포인터는 만료되지 않는다. 이 정리가 주 경계이므로 1차 실행 전에 지운다.
    [[ -n $explicit_output_dir ]] || clear_pointer
    # errexit 가 여기서 스크립트를 끝내면 쿼터 우회에 도달하지 못한다.
    # 1차 종료 코드를 잡아두고 판정은 남은 증거로 한다.
    primary_code=0
    run_stage "$profile" || primary_code=$?
    bypass_ok=0
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
          bypass_ok=1
          echo "[pair] 우회 성공 — 이후 publish/send 는 $fallback_dir 를 쓴다" >&2
        else
          echo "[pair] 우회로도 AI 선택을 얻지 못했다 — 기본 산출물로 진행한다" >&2
        fi
      fi
    fi
    # 우회가 정본을 만들었으면 1차 실패는 흡수된다. 아니면 그대로 전파한다.
    [[ $bypass_ok -eq 1 ]] && exit 0
    exit "$primary_code"
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
