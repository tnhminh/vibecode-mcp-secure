# Architecture Decisions

- ChatGPT remains the reasoning/coding brain.
- MCP is an execution/context/verification bridge; no inference model is embedded.
- Local MCP binds to loopback only.
- Secure MCP Tunnel is the remote transport.
- Workspace filesystem boundary is mandatory.
- Shell defaults to an allowlist.
- Browser external navigation defaults to denied.
- Git is used as the primary checkpoint/review mechanism.
