#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: run-with-lock.sh <lock-file> <command> [args...]" >&2
  exit 64
fi

lock_file=$1
shift
mkdir -p "$(dirname -- "$lock_file")"
exec flock -n -E 75 "$lock_file" "$@"
