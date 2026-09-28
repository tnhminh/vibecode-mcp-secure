#!/usr/bin/env bash

# Load simple KEY=VALUE lines from .env without evaluating it as shell code.
load_dotenv() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#${line%%[![:space:]]*}}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%${key##*[![:space:]]}}"
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$file"
}

wait_http_ok() {
  local url="$1" tries="${2:-40}" i
  for ((i=0; i<tries; i++)); do
    if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

require_node_20() {
  command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required. Install it from https://nodejs.org/" >&2; return 1; }
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]] || { echo "Node.js 20+ is required (found $(node -v))." >&2; return 1; }
}
