# Handoff — 2026-09-08

## Start here

1. Read `AGENTS.md`, `PROJECT_SPEC.md`, and `STATUS.md`.
2. Run `git status --short` before changing anything.
3. Start or inspect the runtime with `VibecodeMCP.Cli.exe --status`; use `--restart` only when a restart is needed.
4. Verify `http://127.0.0.1:1167/readyz` reports `ready: true` and the expected `serverRoot`.

## Runtime model

- Local MCP listens on loopback, default port `1167`; Secure MCP Tunnel is the sole remote transport.
- All project-scoped tools require `projectId`. Do not reintroduce fallback or active-project routing.
- Project registry data is stored under `.runtime/projects.json` and is local machine state, not product source.
- Each project owns generated `frontend`, `backend`, and `worker` port assignments. Allocation must avoid registry collisions and active OS listeners.
- The Control Center is local-only and manages approved project folders, permissions, and port visibility.
- `VibecodeMCP.Cli.exe` starts a health watcher. Its log and PID are in `.runtime/watcher.log` and `.runtime/watcher.pid`.

## Important safety invariants

- Never operate outside an approved project workspace through MCP tools.
- Do not kill or replace a process merely because it owns port `1167`; the watcher intentionally leaves unknown port owners alone.
- Do not print runtime API keys, tunnel IDs, or encrypted runtime material.
- Preserve `projectId` as mandatory in tool schemas and runtime resolution.
- Keep project management endpoints loopback-only.

## Known follow-up: policy false positives

Recent Activity can show red `POLICY_DENIED` entries for two different reasons:

1. Correct safety blocks: dangerous command patterns, global Git config, or executables not in the allowlist.
2. Current parser false positives: `validateCommand` splits `&&`, `|`, `;`, and `&` without respecting quoted inline script content. For example, a `node -e "const ...; ..."` command can be misread as trying to execute `const`.

Recommended fix:

1. Replace separator splitting in `src/server.mjs` with quote-aware Windows command parsing, while preserving checks on genuine command chains.
2. Narrow `/\bformat\b/i` so it does not block PowerShell `Format-List`.
3. Decide and test a minimal read-only diagnostic allowlist (`netstat`, `tasklist`) rather than enabling `workspace-trusted` by default.
4. Add self-test coverage for quoted `node -e` scripts and intentional chained-command bypass attempts.

## Before declaring a change complete

Run the relevant checks (`npm run check`, `npm run build:launcher`, self-test where runtime/policy changes apply), restart local MCP if runtime behavior changed, browser-test affected Control Center flows, review `git diff`, then commit only scoped changes.
