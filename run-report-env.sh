#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
_requested_mode="${MODE:-}"
_requested_weekly_profile="${REDMINE_WEEKLY_PROFILE:-}"
_requested_pair_depth="${WEEKLY_PUBLISH_DEPTH:-2}"
_requested_briefing_channel_set=${SLACK_BRIEFING_CHANNEL_ID+x}
_requested_briefing_channel=${SLACK_BRIEFING_CHANNEL_ID:-}
_requested_meeting_date_set=0
_requested_output_dir_set=0
_requested_snapshot_path_set=0
if [[ ${MEETING_DATE+x} ]]; then
  _requested_meeting_date_set=1
  _requested_meeting_date=$MEETING_DATE
fi
if [[ ${OUTPUT_DIR+x} ]]; then
  _requested_output_dir_set=1
  _requested_output_dir=$OUTPUT_DIR
fi
if [[ ${SNAPSHOT_PATH+x} ]]; then
  _requested_snapshot_path_set=1
  _requested_snapshot_path=$SNAPSHOT_PATH
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -n "$_requested_mode" ]]; then
  export MODE="$_requested_mode"
else
  export MODE="${MODE:-generate}"
fi
unset _requested_mode

# Pair publication is an explicit per-invocation choice; .env must not select depth3 silently.
if [[ "$MODE" == weekly-pair-* ]]; then
  export WEEKLY_PUBLISH_DEPTH="$_requested_pair_depth"
  if [[ $_requested_briefing_channel_set == x ]]; then
    export SLACK_BRIEFING_CHANNEL_ID="$_requested_briefing_channel"
  fi
fi
unset _requested_pair_depth _requested_briefing_channel_set _requested_briefing_channel

if [[ -n "$_requested_weekly_profile" ]]; then
  _weekly_profile=$_requested_weekly_profile
else
  _weekly_profile=${REDMINE_WEEKLY_PROFILE:-}
fi
unset _requested_weekly_profile

case $_weekly_profile in
  "")
    ;;
  prepare|prepare-claude)
    export AI_SUMMARIZE=1
    if [[ $_weekly_profile == prepare-claude ]]; then
      export AI_PROVIDER=claude
      export AI_MODEL=opus
    else
      export AI_PROVIDER=codex
      export AI_MODEL=gpt-5.6-sol
    fi
    export AI_EFFORT=low
    export AI_GENERATION_METHOD=source_selection
    export AI_GENERATION_SCOPE=whole
    export SOURCE_SELECTION_FALLBACK=1
    export REPORT_DEPTH=2
    export VALIDATION_MODE=block
    export VALIDATION_OVERRIDE=0
    export PRESENTATION_NOTE_MODE=suggest
    ;;
  publish)
    export AUTO_APPROVE=1
    export REPORT_DEPTH=2
    export VALIDATION_MODE=block
    export VALIDATION_OVERRIDE=0
    export PRESENTATION_NOTE_MODE=suggest
    ;;
  *)
    echo "unknown weekly profile: $_weekly_profile" >&2
    exit 64
    ;;
esac

if [[ -n "$_weekly_profile" ]]; then
  if [[ $_requested_meeting_date_set -eq 1 ]]; then
    export MEETING_DATE="$_requested_meeting_date"
  fi
  if [[ $_requested_output_dir_set -eq 1 ]]; then
    export OUTPUT_DIR="$_requested_output_dir"
  fi
  if [[ $_requested_snapshot_path_set -eq 1 ]]; then
    export SNAPSHOT_PATH="$_requested_snapshot_path"
  fi
fi
unset REDMINE_WEEKLY_PROFILE _weekly_profile
unset _requested_meeting_date_set _requested_output_dir_set _requested_snapshot_path_set
unset _requested_meeting_date _requested_output_dir _requested_snapshot_path 2>/dev/null || true

# NOTION_API_KEY는 ~/.bashrc를 single source of truth로 사용한다.
# 해당 줄을 eval 로 실행하지는 않는다 — .bashrc 한 줄에 다른 명령이 이어 붙어 있으면
# 키를 읽으려다 그 명령까지 함께 실행된다. 값만 잘라 대입한다.
# 값 문자 집합을 화이트리스트로 고정하지 않고 구분자(공백·세미콜론·따옴표)로 자른다 —
# 토큰 형식이 바뀌어도 값이 잘리지 않고, sed -E 없이 bash 파라미터 확장만 쓴다.
if [[ -z "${NOTION_API_KEY:-}" && -f "$HOME/.bashrc" ]]; then
  _notion_line=$(grep -E '^[[:space:]]*export[[:space:]]+NOTION_API_KEY=' "$HOME/.bashrc" | tail -1 || true)
  if [[ -n "$_notion_line" ]]; then
    _notion_value=${_notion_line#*NOTION_API_KEY=}   # = 뒤 전체
    # 따옴표로 감쌌으면 닫는 따옴표까지가 값이다 — 값 안의 세미콜론·공백을 보존한다.
    # 감싸지 않았으면 공백이나 세미콜론에서 자른다(주석·후속 명령 절단).
    case $_notion_value in
      \"*) _notion_value=${_notion_value#\"}; _notion_value=${_notion_value%%\"*} ;;
      \'*) _notion_value=${_notion_value#\'}; _notion_value=${_notion_value%%\'*} ;;
      *)  _notion_value=${_notion_value%%[[:space:]]*}; _notion_value=${_notion_value%%;*} ;;
    esac
    if [[ -n "$_notion_value" ]]; then
      export NOTION_API_KEY="$_notion_value"
    fi
    unset _notion_value
  fi
  unset _notion_line
fi

export TZ=Asia/Seoul
export PATH="/home/jhw/.nvm/versions/node/v24.12.0/bin:/home/jhw/.local/bin:$PATH"

# 알림 자격증명은 repowire가 이미 쓰는 ~/.repowire/config.yaml을 single source of truth로
# 둔다. 섹션 범위를 막아 다른 섹션의 동명 키(slack.bot_token vs telegram.bot_token)를
# 집지 않게 한다. 값이 없거나 YAML null이면 빈 문자열 — 호출부가 "미설정"으로 처리한다.
repowire_conf_value() {
  local section=$1 key=$2 conf="$HOME/.repowire/config.yaml" value
  [[ -f "$conf" ]] || return 0
  value=$(sed -n "/^${section}:/,/^[^[:space:]]/{s/^[[:space:]]*${key}:[[:space:]]*//p}" "$conf" \
    | tr -d '"'"'"' \t\r' | head -1)
  [[ "$value" == "null" ]] && value=""
  printf '%s' "$value"
}

if [[ "$MODE" == weekly-pair-send ]]; then
  export SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-$(repowire_conf_value slack bot_token)}"
  # The existing failure-alert channel may be shared. Private reports require an explicit destination.
  # Never fall back to SLACK_CHANNEL_ID or Repowire's channel_id here.
fi

# cron 실행은 실패해도 아무도 모른 채 지나간다 (2026-07-22·07-29 게시가 2주 연속
# 조용히 누락된 원인). 실패를 반드시 눈에 띄게 남긴다.
set +e
bash "$ROOT/scripts/run-with-lock.sh" "$ROOT/out/report-run.lock" node "$ROOT/index.js"
status=$?
set -e

# 알림 한 줄을 모든 채널로 보낸다. 전부 best-effort라 어떤 채널이 실패해도 호출부의
# exit status를 바꾸지 않는다.
#   $1 알림 한 줄, $2 notify-send 긴급도, $3 notify-send 제목, $4 notify-send 본문
send_alert() {
  local alert=$1 urgency=$2 title=$3 body=$4 tg_token tg_chat sl_token sl_chan sl_text
  # ALERT.log가 알림을 남기는 주 방어선이다. out/은 gitignore라 clone 직후에는 없고,
  # 그 상태에서 || true가 기록 실패를 삼키면 알림 자체가 사라진다. 먼저 만들어 둔다.
  mkdir -p "$ROOT/out" || true
  # set -e 상태이므로 알림 실패(디스크 풀 등)가 exit $status 도달을 막지 않게 한다.
  echo "$alert" >&2 || true
  printf '%s\n' "$alert" >> "$ROOT/out/ALERT.log" || true
  # 데스크톱 알림은 best-effort — cron에는 세션 버스가 없을 수 있으므로 실패를 무시한다.
  DISPLAY="${DISPLAY:-:0}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
    notify-send -u "$urgency" "$title" "$body" >/dev/null 2>&1 || true

  # 원격 푸시 — 새벽 크론 실패는 화면 앞에 사람이 없어 notify-send가 사라진다.
  # 두 채널 모두 자격증명이 없으면 조용히 건너뛴다(설정 강제 아님). 하나가 실패해도
  # 나머지 채널과 exit $status 도달을 막지 않도록 전부 best-effort로 둔다.
  tg_token="${TELEGRAM_BOT_TOKEN:-$(repowire_conf_value telegram bot_token)}"
  tg_chat="${TELEGRAM_CHAT_ID:-$(repowire_conf_value telegram chat_id)}"
  if [[ -n "$tg_token" && -n "$tg_chat" ]]; then
    curl -sS -m 10 -o /dev/null \
      --data-urlencode "text=${alert}" \
      -d "chat_id=${tg_chat}" \
      "https://api.telegram.org/bot${tg_token}/sendMessage" >/dev/null 2>&1 || true
  fi

  # Slack chat.postMessage — bot_token(xoxb-)과 channel_id가 둘 다 있어야 보낸다.
  # app_token(xapp-)은 Socket Mode 수신용이라 게시에는 쓰지 않는다.
  sl_token="${SLACK_BOT_TOKEN:-$(repowire_conf_value slack bot_token)}"
  sl_chan="${SLACK_CHANNEL_ID:-$(repowire_conf_value slack channel_id)}"
  if [[ -n "$sl_token" && -n "$sl_chan" ]]; then
    # alert는 한 줄이라 JSON 문자열에 넣을 때 역슬래시와 큰따옴표만 이스케이프하면 된다.
    sl_text=${alert//\\/\\\\}
    sl_text=${sl_text//\"/\\\"}
    curl -sS -m 10 -o /dev/null \
      -H "Authorization: Bearer ${sl_token}" \
      -H "Content-type: application/json; charset=utf-8" \
      -d "{\"channel\":\"${sl_chan}\",\"text\":\"${sl_text}\"}" \
      https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
  fi
  return 0
}

# 쌍 게시가 검토 블록을 붙였으면(review-needed.json) 회의 날짜당 한 번만 [REVIEW]를 보낸다.
# 래퍼는 index.js가 계산한 회의 날짜를 알 수 없으므로(publish auto는 MEETING_DATE가 없다)
# MEETING_DATE가 있으면 그 날짜만, 없으면 알림 표식이 없는 모든 날짜를 본다.
# 어떤 실패도 래퍼의 exit status를 바꾸지 않는다.
notify_review_needed() {
  local pair_root=${OUTPUT_DIR:-out} file dir meta variant codes detail alert
  [[ "$pair_root" = /* ]] || pair_root="$ROOT/$pair_root"
  pair_root="$pair_root/pairs"
  local -a files=()
  if [[ -n "${MEETING_DATE:-}" ]]; then
    files=("$pair_root/$MEETING_DATE/review-needed.json")
  else
    files=("$pair_root"/*/review-needed.json)
  fi
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    dir=${file%/*}
    [[ -e "$dir/review-needed.notified" ]] && continue
    # 첫 줄 variant, 둘째 줄 codes(쉼표 결합). 읽기·파싱 실패는 고정 문구로 대체한다.
    if meta=$(node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof j.variant !== "string" || !Array.isArray(j.codes)) process.exit(1);
      console.log(j.variant.replace(/\s+/g, " "));
      console.log(j.codes.map(String).join(",").replace(/\s+/g, " "));
    ' "$file" 2>/dev/null); then
      variant=${meta%%$'\n'*}
      codes=${meta#*$'\n'}
      detail="변형 ${variant}, 사유 ${codes}"
    else
      detail="(review-needed.json 읽기 실패)"
    fi
    alert="[REVIEW] $(date '+%F %T') redmine 검토 필요 — ${detail} (위키 하단 참고)"
    send_alert "$alert" normal "Redmine 검토 필요" "$alert"
    # 표식은 알림을 보낸 뒤에만 만든다. 만들지 못하면 다음 실행이 다시 보낸다.
    : > "$dir/review-needed.notified" || true
  done
  return 0
}

if [[ $status -ne 0 ]]; then
  alert="[ALERT] $(date '+%F %T') redmine 보고 실패 — MODE=${MODE} exit=${status} (로그: $ROOT/out/cron.log)"
  send_alert "$alert" critical "Redmine 보고 실패" "MODE=${MODE} exit=${status}"
elif [[ "$MODE" == weekly-pair-publish ]]; then
  notify_review_needed || true
fi

exit $status
