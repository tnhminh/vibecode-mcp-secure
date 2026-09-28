#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/macos/env.sh"
cd "$ROOT"

[[ "$(uname -s)" == "Darwin" ]] || { echo "SETUP-MACOS.command only runs on macOS." >&2; exit 1; }
require_node_20
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }

echo "Installing npm dependencies..."
npm install
echo "Installing Playwright Chromium..."
npx playwright install chromium
[[ -f .env ]] || cp .env.example .env
echo "Installing official tunnel-client for macOS..."
node scripts/macos/install-tunnel-client.mjs
npm run check
echo
echo "SETUP COMPLETE"
echo "Edit .env with a macOS workspace path and tunnel ID, then double-click START-MACOS.command."
