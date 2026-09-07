# Status — 2026-09-08

## Current state

Vibecode MCP Secure is a local-first, multi-project execution harness. ChatGPT supplies reasoning; this repository supplies deterministic local tools, policy enforcement, observability, and Secure MCP Tunnel transport. It does not run a second LLM.

The local runtime is healthy when `/healthz` and `/readyz` report success on the configured loopback port (default `1167`). The CLI launcher also starts the Secure MCP Tunnel runtime and a local watcher.

## Delivered capabilities

- Explicit project routing: all project-scoped MCP calls require `projectId`; legacy fallback routing is removed.
- Loopback-only Control Center: add approved projects, browse drives/folders, create a selected child folder, manage per-project permissions, and inspect project state.
- Per-project port plan: `frontend`, `backend`, and `worker` ports are generated without colliding with another approved project or an active local listener.
- Availability watcher: checks MCP health every 10 seconds; when the listener is absent it restarts MCP, but does not replace an unknown process occupying the port.
- CLI-only portable package: includes Node, tunnel client, dependencies, and Playwright Chromium; no desktop GUI executable is shipped.
- Security/observability: canonical workspace boundaries, symlink/junction checks, command policy, loopback browser policy, redacted NDJSON audit events, and project-scoped permission gates.

## Verification evidence

- `npm run check` passed after the current runtime changes.
- `npm run build:launcher` passed after watcher changes.
- CLI self-test passed.
- Local restart was verified through `/readyz` with the expected repository root and multi-project routing enabled.
- Watcher recovery was tested by terminating the MCP listener; it restored health and recorded the restart.

## Known limitation / next hardening item

The shell allowlist parser currently splits on command separators even when they occur inside a quoted inline script. This creates false `POLICY_DENIED` audit events for some valid `node -e "..."` commands. The deny rules also classify `Format-List` as `format` because the pattern is too broad. Intentional denials (global Git configuration, dangerous commands, and executables outside the allowlist) remain correct.

Do not disable the policy globally as a workaround. The next change should use quote-aware command tokenization, narrow the `format` dangerous-command rule, and explicitly decide whether read-only diagnostics such as `netstat` and `tasklist` belong in the allowlist.
