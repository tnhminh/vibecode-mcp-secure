# Vibecode MCP Secure

Local-first coding MCP for **ChatGPT Web -> OpenAI Secure MCP Tunnel -> your Windows PC -> local project**.

This project intentionally keeps the architecture simple:

- **ChatGPT = brain**: understand, plan, review, decide.
- **Vibecode MCP = hands**: inspect/edit files, run commands, manage dev processes, Git, verify, browser-test.
- **OpenAI Secure MCP Tunnel = transport**: outbound-only connection to the OpenAI tunnel control plane; the local MCP remains bound to `127.0.0.1`.
- **No second LLM and no model API is used by this project.** The OpenAI runtime key used by `tunnel-client` authenticates the tunnel transport; it is not a model inference key used by this MCP server.

## What is implemented

### Layer 1 — Transport / Bridge

- Local Streamable HTTP MCP endpoint: `http://127.0.0.1:1167/mcp`
- Official OpenAI `tunnel-client` installer/launcher
- `runtimes connect` + `runtimes status`
- `/healthz`, `/readyz`, local Operations Control Center
- runtime Overview for projects/workspace, Git, processes, verification, activity, security and Tunnel state
- Multi-Project Router registry: approve multiple local workspaces, keep them concurrently enabled, choose a `defaultProjectId`, and persist per-project tool permissions

### Layer 2 — Execution Runtime

- `read_file`, `read_range`, `write_file`, `apply_patch`, `delete_path`
- `tree`, `search_text`
- `run_command`
- `start_process`, `process_list`, `process_logs`, `stop_process`
- Git tools
- Playwright browser tools
- all project-scoped tools accept optional `projectId`; omitted `projectId` routes to the default project

### Layer 3 — Code Intelligence / Context

- `repo_map`
- repository tree + package scripts + Git state
- literal/regex code search
- range-based file reading to reduce context usage

LSP/AST semantic navigation is left as the next extension point rather than shipping a brittle language-specific implementation in v0.1.

### Layer 4 — Verification

- `verify_project`
- automatically runs available `lint -> typecheck/check -> test -> build` scripts
- browser runtime inspection via Playwright

### Layer 5 — Safety / Observability

- canonical workspace boundary enforcement, including symlink/junction escape checks
- shell command allowlist by default, including Windows command-chaining regression protection
- explicit dangerous-command deny rules
- external browser URLs blocked by default
- NDJSON audit log with recursive secret/source-content redaction
- Operations Control Center and enriched status endpoint
- project registry with loopback-only Add/Remove/permission changes; MCP can route only to already-approved projects and can change only the default fallback, never widen filesystem scope

### Layer 6 — Harness / Skills

- `.vibecode/` project-state scaffold
- `AGENTS.md` coding workflow contract
- reusable skill prompts under `skills/`
- intentionally no background LLM / multi-agent runtime

---

# Windows quick start

## Fastest path — one click

For an already prepared installation, double-click:

```text
VibecodeMCP.exe
```

The Windows launcher starts/checks the local MCP, waits for health/readiness, reconnects the Secure MCP Tunnel when needed, verifies tunnel status, and opens the Control Center.

For a brand-new machine/install, run once:

```text
FIRST-RUN.cmd
```

It runs Setup, then uses `VibecodeMCP.exe --configure` for one-time workspace/tunnel configuration.

## 0. Prerequisites

Install:

- Windows 10/11
- Git
- Node.js 20+
- An OpenAI organization/workspace with access to Secure MCP Tunnels

## 1. Extract this project

Example:

```powershell
C:\vibecode-mcp-secure
```

## 2. Run setup

Double-click:

```text
SETUP.cmd
```

It will:

1. run `npm install`;
2. install Playwright Chromium;
3. download the latest official Windows x64 `openai/tunnel-client` release;
4. verify the archive SHA256 when the release publishes `SHA256SUMS.txt`;
5. place `tunnel-client.exe` under `bin\`;
6. run project syntax checks;
7. run an end-to-end local MCP self-test (`healthz`, MCP connect, `tools/list`, and a `health` tool call).

## 3. Create a Secure MCP Tunnel in OpenAI Platform

Open:

```text
https://platform.openai.com/settings/organization/tunnels
```

Create a tunnel attached to the ChatGPT workspace that will use it.

You need the returned value:

```text
CONTROL_PLANE_TUNNEL_ID=tunnel_...
```

For the long-running tunnel client, create a **Restricted Runtime API key** with:

```text
Tunnels Read + Use
```

Do not use an Admin API key for the runtime daemon.

Runtime API keys:

```text
https://platform.openai.com/settings/organization/api-keys
```

## 4. Configure the local workspace

Double-click:

```text
CONFIGURE.cmd
```

Enter:

- project workspace, for example `E:\kpi-performance-starter`
- `tunnel_...` ID

The runtime API key is deliberately not stored in `.env`. The Windows launcher can store it encrypted with Windows DPAPI under `.runtime`, scoped to the current Windows user.

## 5. Start everything

Preferred Windows launcher:

```text
VibecodeMCP.exe
```

`START.cmd` now delegates to the EXE when it is present and falls back to the PowerShell launcher otherwise.

The EXE:

1. discovers/normalizes the local stable configuration (default port `1167`);
2. starts the MCP only when it is not already healthy;
3. waits for `/healthz` and `/readyz`;
4. reuses an existing tunnel profile when possible;
5. if credentials are needed, requests the Runtime API key once and stores it encrypted with Windows DPAPI under `.runtime`;
6. runs official `tunnel-client runtimes connect` when required;
7. verifies `runtimes status`;
8. opens the local Control Center.

Useful modes:

```text
VibecodeMCP.exe --status
VibecodeMCP.exe --stop
VibecodeMCP.exe --configure
VibecodeMCP.exe --reset-key
VibecodeMCP.exe --self-test
VibecodeMCP.exe --no-open
```

Local Control Center:

```text
http://127.0.0.1:1167/
```

Local MCP endpoint:

```text
http://127.0.0.1:1167/mcp
```

## 6. Connect ChatGPT

In ChatGPT:

```text
Settings
 -> Connectors
 -> Add/configure MCP connector
 -> Connection: Tunnel
 -> select the tunnel or paste tunnel_id
```

The tunnel ID used in ChatGPT and by the local runtime must be the same.

## 7. Diagnose

Double-click:

```text
DOCTOR.cmd
```

It checks:

- local MCP health
- workspace readiness
- tunnel-client version
- tunnel runtime status
- recent MCP stderr

## 8. Stop

Double-click:

```text
STOP.cmd
```

This stops both the local tunnel runtime and the MCP process.

---

# Tool list

## Files / context

```text
health
project_info
tree
repo_map
read_file
read_range
write_file
apply_patch
delete_path
search_text
```

## Execution

```text
run_command
start_process
process_list
process_logs
stop_process
```

## Git

```text
git_status
git_diff
git_log
git_add
git_commit
git_restore
```

## Verification

```text
verify_project
```

## Browser

```text
browser_open
browser_click
browser_fill
browser_snapshot
browser_screenshot
browser_close
```

## Observability

```text
audit_tail
```

---

# Recommended first prompt in ChatGPT

```text
Use the Vibecode MCP tools for the active workspace.

Before changing code:
1. call health and project_info;
2. inspect AGENTS.md / PROJECT_SPEC.md if they exist;
3. call repo_map;
4. use search_text and read_range rather than reading the whole repository;
5. inspect git_status.

For implementation:
UNDERSTAND -> INSPECT -> PLAN -> IMPLEMENT -> VERIFY -> RUN -> BROWSER TEST -> REVIEW GIT DIFF -> FIX -> VERIFY -> DONE.

Prefer apply_patch over rewriting whole files.
Do not touch files outside the configured workspace.
Do not claim DONE unless relevant verification passes.
```

---

# Security model

The server listens on `127.0.0.1` only. Secure MCP Tunnel is expected to be the only remote path to it.

Filesystem tools enforce the configured workspace root. Shell execution is different: a child process technically has the permissions of your Windows account. The default `allowlist` reduces risk but is **not an OS sandbox**. For sensitive machines, run Vibecode MCP under a dedicated low-privilege Windows account or VM.

Never put the Runtime API key in source code, Git, `AGENTS.md`, or prompts. `START.cmd` can hold it only in the process environment for the tunnel runtime.

See `docs/SECURITY.md`.

---

# Current Secure Tunnel references

OpenAI official/public references used for this starter:

- `https://github.com/openai/tunnel-client`
- `https://github.com/openai/tunnel-client/releases/latest`
- `https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md`
- `https://github.com/openai/tunnel-client/blob/master/docs/configuration.md`
- `https://platform.openai.com/settings/organization/tunnels`

The setup script intentionally downloads the **latest release at setup time** instead of pinning a stale tunnel binary inside this ZIP.
