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
                 configured workspace
```

## Trust boundaries

### Remote boundary

No inbound Internet listener is required. `tunnel-client` initiates outbound HTTPS to the OpenAI tunnel service.

### MCP boundary

The MCP HTTP listener binds to `127.0.0.1`, not `0.0.0.0`.

### Workspace boundary

Filesystem and Git paths are resolved relative to `VIBECODE_WORKSPACE` and rejected when they escape the root.

### Shell boundary

The command tool runs child processes under the Windows account that started MCP. The default command allowlist is a policy layer, not kernel isolation.

## Why no background LLM

The design avoids duplicating planning/coding/review models under the MCP. This keeps state simpler, avoids inference API cost, and makes the tool layer observable and deterministic.
