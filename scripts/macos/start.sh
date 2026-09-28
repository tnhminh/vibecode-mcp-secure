#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/macos/env.sh"
cd "$ROOT"

[[ "$(uname -s)" == "Darwin" ]] || { echo "START-MACOS.command only runs on macOS." >&2; exit 1; }
require_node_20
load_dotenv "$ROOT/.env"
[[ -n "${VIBECODE_WORKSPACE:-}" && "${VIBECODE_WORKSPACE:-}" != *your-project* && -d "$VIBECODE_WORKSPACE" ]] || { echo "Set VIBECODE_WORKSPACE to an existing macOS folder in .env first." >&2; exit 1; }
[[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" && "${CONTROL_PLANE_TUNNEL_ID:-}" != *REPLACE_ME* ]] || { echo "Set CONTROL_PLANE_TUNNEL_ID in .env first." >&2; exit 1; }

PORT="${VIBECODE_PORT:-1167}"
HEALTH="http://127.0.0.1:${PORT}/healthz"
READY="http://127.0.0.1:${PORT}/readyz"
MCP_URL="http://127.0.0.1:${PORT}/mcp"
RUNTIME="$ROOT/.runtime"
PID_FILE="$RUNTIME/mcp.pid"
TUNNEL="$ROOT/bin/tunnel-client"
mkdir -p "$RUNTIME"

if ! wait_http_ok "$HEALTH" 2; then
  echo "Starting local MCP server on 127.0.0.1:${PORT}..."
  nohup node src/server.mjs >>"$RUNTIME/mcp.stdout.log" 2>>"$RUNTIME/mcp.stderr.log" < /dev/null &
  echo $! > "$PID_FILE"
  wait_http_ok "$HEALTH" 40 || { echo "MCP failed to start; see $RUNTIME/mcp.stderr.log" >&2; exit 1; }
fi
wait_http_ok "$READY" 8 || { echo "MCP is alive but not ready; check $READY." >&2; exit 1; }

[[ -x "$TUNNEL" ]] || { echo "tunnel-client is missing. Run SETUP-MACOS.command first." >&2; exit 1; }
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  read -r -s -p "OpenAI Runtime API key (not saved): " CONTROL_PLANE_API_KEY
  echo
  export CONTROL_PLANE_API_KEY
fi
[[ -n "$CONTROL_PLANE_API_KEY" ]] || { echo "Runtime API key is required." >&2; exit 1; }

ALIAS="${TUNNEL_ALIAS:-vibecode-local}"
echo "Connecting Secure MCP Tunnel '$ALIAS'..."
"$TUNNEL" runtimes connect --alias "$ALIAS" --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url "$MCP_URL"
"$TUNNEL" runtimes status "$ALIAS" --json
echo "VIBECODE MCP IS RUNNING"
echo "Control Center: http://127.0.0.1:${PORT}/"
