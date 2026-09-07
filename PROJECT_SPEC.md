# PROJECT_SPEC — Vibecode MCP Secure v0.2

## Product goal

Provide a local-first coding execution bridge that lets ChatGPT operate a configured Windows development workspace through OpenAI Secure MCP Tunnel without embedding a second inference model.

## Primary flow

```text
ChatGPT
  -> Secure MCP Tunnel
  -> official tunnel-client
  -> local MCP on 127.0.0.1
  -> configured workspace
```

## v0.1 scope

### Required

- official Secure MCP Tunnel integration
- Streamable HTTP MCP server
- workspace-scoped filesystem tools
- targeted patching and search
- shell command execution with policy controls
- long-running dev process manager
- Git status/diff/log/stage/commit/restore
- verification runner
- local browser automation
- health/readiness endpoints
- local status UI
- audit log
- concurrent multi-project routing with an explicit `projectId` on every project-scoped tool call
- loopback-only project picker and per-project permissions
- deterministic per-project frontend/backend/worker port plans that avoid assigned and locally-listening ports
- CLI health watcher that recovers a missing MCP listener without replacing an unknown process
- Windows setup/config/start/stop/doctor scripts

### Deliberately deferred

- LSP multiplexing
- tree-sitter/AST symbol graph
- persistent semantic index
- background LLM workers
- autonomous multi-agent orchestration
- remote shell exposure outside Secure MCP Tunnel

## Non-goals

- clone Codex internally
- store OpenAI runtime secrets in source control
- expose the MCP server publicly
- bypass workspace restrictions

## Definition of Done for v0.1 package

- source parses successfully with Node
- configuration is externalized
- runtime API key is not checked into the package
- setup script installs dependencies and current tunnel-client on user machine
- start script starts MCP, checks health/readiness, connects tunnel, then checks runtime status
- stop and doctor scripts exist
- operator README and security limitations are documented
