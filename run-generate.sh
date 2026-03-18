#!/usr/bin/env bash
set -euo pipefail

# Minimal defaults; override as needed.
export REDMINE_BASE_URL="${REDMINE_BASE_URL:-http://192.168.10.2:30002}"
export PROJECT_ID="${PROJECT_ID:-team-4-weekly-meeting}"
export PAGE_SUFFIX="${PAGE_SUFFIX:-개발4팀_주간_회의}"
export REPO_ROOT="${REPO_ROOT:-/home/jhw/ai/codex/projects}"
export OUTPUT_DIR="${OUTPUT_DIR:-/home/jhw/ai/codex/redmine-auto/out}"
export TEMPLATE_PATH="${TEMPLATE_PATH:-/home/jhw/ai/codex/redmine-auto/templates/jo-hyunwoo.md}"
export AI_EN_PATH="${AI_EN_PATH:-/home/jhw/ai/codex/redmine-auto/templates/ai-en.md}"
export AI_KO_PATH="${AI_KO_PATH:-/home/jhw/ai/codex/redmine-auto/templates/ai-ko.md}"

export MODE=generate

node /home/jhw/ai/codex/redmine-auto/update-jo-hyunwoo.api.js
