#!/usr/bin/env bash
set -u

if [[ $# -ne 2 ]]; then
  exit 64
fi

lock_file=$1
status_file=$2
exec 9>>"$lock_file"

if flock -n 9; then
  release_status() {
    flock -u 9
    printf 'released\n' >"$status_file"
  }
  trap release_status EXIT
  printf 'locked\n' >"$status_file"
  read -r _ || true
  exit 0
fi

printf 'busy\n' >"$status_file"
exit 75
