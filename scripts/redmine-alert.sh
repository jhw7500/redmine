#!/usr/bin/env bash
# 크론 실패(out/ALERT.log)를 셸 진입 시 눈에 띄게 만든다.
#
# 2026-08-12 게시 실패를 3시간 뒤에야 알아챘다. 그 시점의 알림 경로는 ALERT.log 파일과
# notify-send뿐이었는데, 전자는 아무도 열어보지 않고 후자는 새벽 크론 시간에 화면 앞에
# 사람이 없으면 사라진다. 하루에도 여러 번 여는 터미널이 가장 확실한 전달 경로다.
#
# usage:
#   redmine-alert.sh          미확인 실패만 출력 (없으면 무출력·exit 0)
#   redmine-alert.sh --ack    현재까지를 확인 처리
set -uo pipefail

ROOT=/home/jhw/ai/opencode/projects/redmine
LOG="$ROOT/out/ALERT.log"
ACK="$ROOT/out/ALERT.ack"

[[ -f "$LOG" ]] || exit 0

total=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
[[ "$total" =~ ^[0-9]+$ ]] || exit 0

seen=0
if [[ -f "$ACK" ]]; then
  seen=$(tr -d '[:space:]' < "$ACK" 2>/dev/null)
  # ack 파일이 깨졌거나 ALERT.log가 잘려 seen이 total을 넘으면 전부 미확인으로 되돌린다.
  # 확인한 것을 다시 보여주는 쪽이, 못 본 실패를 삼키는 쪽보다 안전하다.
  [[ "$seen" =~ ^[0-9]+$ ]] || seen=0
  (( seen > total )) && seen=0
fi

if [[ "${1:-}" == "--ack" ]]; then
  printf '%s\n' "$total" > "$ACK"
  echo "[redmine] 실패 알림 ${total}건 확인 처리"
  exit 0
fi

pending=$(( total - seen ))
(( pending > 0 )) || exit 0

printf '\033[1;31m[redmine] 미확인 주간보고 크론 실패 %d건\033[0m\n' "$pending"
tail -n "$pending" "$LOG" | sed 's/^/  /'
printf '  확인 처리: \033[1m%s --ack\033[0m\n' "$ROOT/scripts/redmine-alert.sh"
