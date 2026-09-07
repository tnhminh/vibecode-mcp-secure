# Troubleshooting

## MCP does not start

Run:

```text
DOCTOR.cmd
```

Inspect:

```text
.runtime\mcp.stdout.log
.runtime\mcp.stderr.log
```

Confirm the configured workspace exists.

## Another Vibecode checkout is using the configured port

Each Vibecode checkout identifies its own source root through the local health endpoint. The launcher refuses to reuse or stop a different checkout on the same port, preventing a Control Center from silently managing the wrong server.

Stop the other checkout first, or configure this checkout with a different local port and a matching tunnel runtime.

## Browser tools complain that Chromium is missing

From the project folder:

```powershell
npx playwright install chromium
```

## Tunnel connects but ChatGPT cannot see it

Check all of these:

1. The tunnel was created with the correct ChatGPT workspace scope.
2. The runtime principal has `Tunnels Read + Use`.
3. `DOCTOR.cmd` reports local MCP ready.
4. `tunnel-client runtimes status <alias> --json` reports a healthy/running runtime.
5. ChatGPT connector uses the same `tunnel_id`.
6. A newly created tunnel may need a short control-plane propagation period.

## Tunnel client missing

Re-run:

```text
SETUP.cmd
```

The setup script fetches the latest official Windows x64 release from `openai/tunnel-client`.

## Command denied

The default shell mode is `allowlist`.

Prefer MCP filesystem tools for file operations. If a trusted project genuinely needs arbitrary shell syntax, change:

```text
VIBECODE_SHELL_MODE=workspace-trusted
```

Then restart MCP.

## Path outside workspace

This is expected behavior. Re-run `CONFIGURE.cmd` if you selected the wrong workspace. Do not weaken the path boundary just to reach another project; use a separate MCP instance/configuration for it.
