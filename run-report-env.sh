#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/jhw/ai/opencode/projects/redmine
_requested_mode="${MODE:-}"

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

# cron 실행은 실패해도 아무도 모른 채 지나간다 (2026-07-22·07-29 게시가 2주 연속
# 조용히 누락된 원인). 실패를 반드시 눈에 띄게 남긴다.
set +e
node "$ROOT/index.js"
status=$?
set -e

if [[ $status -ne 0 ]]; then
  alert="[ALERT] $(date '+%F %T') redmine 보고 실패 — MODE=${MODE} exit=${status} (로그: $ROOT/out/cron.log)"
  # ALERT.log가 실패를 남기는 주 방어선이다. out/은 gitignore라 clone 직후에는 없고,
  # 그 상태에서 || true가 기록 실패를 삼키면 알림 자체가 사라진다. 먼저 만들어 둔다.
  mkdir -p "$ROOT/out" || true
  # set -e 상태이므로 알림 실패(디스크 풀 등)가 exit $status 도달을 막지 않게 한다.
  echo "$alert" >&2 || true
  printf '%s\n' "$alert" >> "$ROOT/out/ALERT.log" || true
  # 데스크톱 알림은 best-effort — cron에는 세션 버스가 없을 수 있으므로 실패를 무시한다.
  DISPLAY="${DISPLAY:-:0}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
    notify-send -u critical "Redmine 보고 실패" "MODE=${MODE} exit=${status}" >/dev/null 2>&1 || true

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
fi

exit $status
