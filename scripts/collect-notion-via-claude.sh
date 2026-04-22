#!/usr/bin/env bash
# Notion 항목을 Claude CLI(MCP OAuth) 통해 수집하여 JSON으로 저장
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${SCRIPT_DIR}/out/notion-items.json"
CLAUDE_CLI="${CLAUDE_CLI:-claude}"

# 1시간 이내 파일이면 건너뛰기
if [[ -f "$OUTPUT" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$OUTPUT") ))
  if (( age < 3600 )); then
    echo "[collect-notion] Fresh file exists (${age}s old), skipping"
    exit 0
  fi
fi

# 날짜 범위: 지난 수요일 ~ 오늘
today=$(date +%Y-%m-%d)
dow=$(date +%u)
if (( dow >= 3 )); then
  days_back=$(( dow - 3 ))
  if (( days_back == 0 )); then days_back=7; fi
else
  days_back=$(( dow + 4 ))
fi
start_date=$(date -d "$today - $days_back days" +%Y-%m-%d)

echo "[collect-notion] Range: $start_date ~ $today"

PROMPT="$(cat <<EOF
notion-search MCP 도구를 사용하여 아래 7개 검색을 각각 수행하라.
모든 검색에 filters: { created_date_range: { start_date: "${start_date}", end_date: "${today}" } }, page_size: 25, max_highlight_length: 0 적용.

검색어 목록:
1. "iMX93 BSP DTS kernel"
2. "wlan-package wlan-driver WiFi"
3. "pim-package gstApp cam_state"
4. "pcap 분석 FX5000 sniffer"
5. "sc16is7xx SPI UART"
6. "redmine automation CI workflow"
7. "jhw-notion email MCP"

모든 검색 결과를 중복 제거하여 하나의 JSON 배열로 출력하라.
AI Workspace, Knowledge Base, Projects, References, Decision Log 등 구조 페이지는 제외.
Claude Code 플러그인/스킬 설명 페이지도 제외.
피드백/규칙 페이지(독립 작업, 롤백 가능, Notion 저장 등)도 제외.

출력 형식 (순수 JSON만, 마크다운 코드블록이나 설명 없이):
[{"source":"notion","title":"페이지 제목","date":"YYYY-MM-DD"},...]
EOF
)"

result=$($CLAUDE_CLI -p "$PROMPT" --output-format text --max-turns 15 --allowedTools 'mcp__notion__notion-search' 2>/dev/null) || {
  echo "[collect-notion] Claude CLI failed, skipping"
  exit 0
}

# JSON 배열 추출: 첫 번째 [ 부터 마지막 ] 까지
json=$(echo "$result" | tr '\n' '\n' | perl -0777 -ne 'print $1 if /(\[.*\])/s')

if [[ -n "$json" ]] && echo "$json" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))" 2>/dev/null; then
  echo "$json" > "$OUTPUT"
  count=$(echo "$json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).length)")
  echo "[collect-notion] Saved $count items to $OUTPUT"
else
  echo "[collect-notion] Could not extract valid JSON"
  # 디버그: 응답 앞부분 출력
  echo "[collect-notion] Response preview: $(echo "$result" | head -5)"
  exit 0
fi
