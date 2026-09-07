# Architecture

```text
┌─────────────────────────────────────────────┐
│ ChatGPT Web / frontier model                │
│ understand • plan • review • fix strategy   │
└──────────────────────┬──────────────────────┘
                       │ MCP connector: Tunnel
                       ▼
┌─────────────────────────────────────────────┐
│ OpenAI Secure MCP Tunnel control plane      │
└──────────────────────▲──────────────────────┘
                       │ outbound HTTPS :443
                       │
┌──────────────────────┴──────────────────────┐
│ official tunnel-client.exe                  │
│ long poll / forward / return MCP result     │
└──────────────────────┬──────────────────────┘
                       │ loopback HTTP
                       ▼
┌─────────────────────────────────────────────┐
│ Vibecode MCP :1167                          │
│                                             │
│ Layer 2: Files / shell / process / git      │
│ Layer 3: repo map / search / context        │
│ Layer 4: verify / browser loop              │
│ Layer 5: policy / sandbox / audit           │
│ Layer 6: AGENTS + skill/harness scaffold    │
└──────────────────────┬──────────────────────┘
                       ▼
          approved project selected by projectId
```

## Trust boundaries

### Remote boundary

No inbound Internet listener is required. `tunnel-client` initiates outbound HTTPS to the OpenAI tunnel service.

### MCP boundary

The MCP HTTP listener binds to `127.0.0.1`, not `0.0.0.0`.

### Workspace and routing boundary

Each approved project has a canonical workspace root. Every project-scoped MCP tool requires `projectId`, resolves only that registry entry, and rejects paths that escape its root. There is no fallback project selection.

### Local operator boundary

The Control Center is loopback-only. It can add/remove approved projects, manage permissions, browse/create a chosen local folder, and show the assigned frontend/backend/worker port plan. Port allocation excludes ports reserved by other approved projects and ports listening on the local machine; it is an allocation plan, not a deployment process by itself.

### Shell boundary

The command tool runs child processes under the Windows account that started MCP. The default command allowlist is a policy layer, not kernel isolation.

## Why no background LLM

The design avoids duplicating planning/coding/review models under the MCP. This keeps state simpler, avoids inference API cost, and makes the tool layer observable and deterministic.

## Availability supervision

`VibecodeMCP.Cli.exe` launches a watcher after MCP and tunnel readiness succeed. The watcher checks `/healthz` every 10 seconds. It restarts MCP only if health fails and the configured listener port is free. When another process owns the port, it logs the conflict rather than terminating or replacing that process. `--stop` stops the tunnel, MCP, and watcher together.
