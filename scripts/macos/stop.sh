#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/macos/env.sh"
cd "$ROOT"

load_dotenv "$ROOT/.env"
ALIAS="${TUNNEL_ALIAS:-vibecode-local}"
TUNNEL="$ROOT/bin/tunnel-client"
[[ -x "$TUNNEL" ]] && "$TUNNEL" runtimes stop "$ALIAS" || true
PID_FILE="$ROOT/.runtime/mcp.pid"
if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID" || true; fi
  rm -f "$PID_FILE"
fi
echo "Stopped launcher-managed MCP/tunnel."
