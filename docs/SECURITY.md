# Security

## Default protections

- MCP binds to loopback (`127.0.0.1`).
- Filesystem operations enforce one canonical workspace root and reject symlink/junction escapes.
- `delete_path` cannot delete the workspace root and requires explicit `confirm=true`.
- `git_restore` requires explicit `confirm=true`.
- shell runs in `allowlist` mode by default.
- high-risk command patterns are denied unless `VIBECODE_ALLOW_DANGEROUS=1`.
- external browser URLs are blocked unless `VIBECODE_BROWSER_ALLOW_EXTERNAL=1`.
- audit arguments recursively redact keys/tokens/secrets/passwords/authorization and omit source-content fields such as content/find/replace/replacement/body.
- Runtime API key is not stored by the generated `.env` flow.

## Regression protections

The self-test verifies that:

- a blocked executable cannot be reached through Windows single-`&` command chaining;
- a filesystem read cannot escape through a workspace junction/symlink;
- file content written through MCP does not appear verbatim in audit output.

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
