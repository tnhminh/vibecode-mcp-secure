# Security

## Default protections

- MCP binds to loopback (`127.0.0.1`).
- Filesystem operations enforce a separate canonical workspace root for each approved project and reject symlink/junction escapes.
- `delete_path` cannot delete the workspace root and requires explicit `confirm=true`.
- `git_restore` requires explicit `confirm=true`.
- shell runs in `allowlist` mode by default.
- high-risk command patterns are denied unless `VIBECODE_ALLOW_DANGEROUS=1`.
- external browser URLs are blocked unless `VIBECODE_BROWSER_ALLOW_EXTERNAL=1`.
- audit arguments recursively redact keys/tokens/secrets/passwords/authorization and omit source-content fields such as content/find/replace/replacement/body.
- Runtime API key is never stored in `.env`. `VibecodeMCP.Cli.exe` stores it encrypted with Windows DPAPI under `.runtime`, scoped to the current Windows user; use `VibecodeMCP.Cli.exe --reset-key` to remove it.
- Project Add/Remove/permission changes are accepted only from the loopback Control Center.
- MCP project routing can only target already-approved registry entries; `local Set Fallback` / legacy `removed switch` only change the fallback and cannot register arbitrary filesystem paths.

## Regression protections

The self-test verifies that:

- a blocked executable cannot be reached through Windows single-`&` command chaining;
- a filesystem read cannot escape through a workspace junction/symlink;
- file content written through MCP does not appear verbatim in audit output.

## Project permissions

Each approved project has tool-level switches for Read, Write, Execute, Process, Git Write, Browser, and Delete. All approved projects remain concurrently enabled; every project-scoped tool resolves its own `projectId` (or the fallback), then enforces that project's gate. Permission failures and resolved project context are audited.

`Execute` is intentionally powerful. If enabled, repository scripts/interpreters still execute with the Windows account's OS permissions and may modify files or Git outside the narrower MCP write/delete/git tool gates. Treat reduced permissions as tool policy, not an OS sandbox. Use a VM/container/low-privilege account for strict isolation.

## Important limitation: shell is not an OS sandbox

A permitted executable can still execute repository scripts, and those scripts run with the permissions of the Windows account. `npm run`, for example, intentionally executes code defined in the target repository.

For untrusted repositories or strict environments, use one of:

1. a dedicated low-privilege Windows account;
2. Windows Sandbox / VM;
3. a disposable development VM;
4. a containerized workspace with a deliberately mounted project directory.

## Shell modes

### allowlist — recommended default

Only common development executables are accepted.

### workspace-trusted

Allows arbitrary shell commands except the explicit dangerous deny patterns. Use only for repositories you trust.

Set in `.env`:

```text
VIBECODE_SHELL_MODE=workspace-trusted
```

## Do not enable by default

```text
VIBECODE_ALLOW_DANGEROUS=1
VIBECODE_BROWSER_ALLOW_EXTERNAL=1
```

These exist for controlled debugging, not normal operation.
