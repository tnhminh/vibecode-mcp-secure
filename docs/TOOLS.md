# MCP Tool Reference

## Project routing

All project-scoped tools accept optional `projectId`. If omitted, the runtime routes the call to `defaultProjectId`. Filesystem boundary, permissions, Git cwd, process ownership, browser state, screenshot artifacts, verification state, and audit context are resolved per project.

## Context and filesystem

### health
Runtime configuration and process/tool counters.

### project_list
Lists all projects already approved from the local Control Center and shows the `defaultProjectId`. All approved projects remain concurrently enabled.

### project_set_default
Sets the fallback project used when a project-scoped tool omits `projectId`. It does not disable or switch off other approved projects.

### project_switch
Backward-compatible alias for `project_set_default`. It no longer represents an exclusive active-project switch.

### project_info
Workspace/package/Git summary for one approved project. Pass `projectId`; omit it to use the default project.

### tree
Compact directory tree with depth and entry limits.

### repo_map
Repository tree plus package scripts, dependencies, Git state, and likely code roots.

### read_file
Reads a bounded UTF-8 file.

### read_range
Reads a 1-based inclusive line range.

### search_text
Literal or regex recursive text search with ignored heavy directories.

### write_file
Workspace-scoped UTF-8 write.

### apply_patch
Exact-text transactional-style edits. Each edit declares `expectedOccurrences`; mismatches fail with `PATCH_CONFLICT` rather than guessing.

### delete_path
Workspace-scoped delete requiring `confirm=true`.

## Shell/process

### run_command
Runs a command with workspace cwd and policy checks.

### start_process
Starts a long-running dev process and returns a managed process id.

### process_list
Lists MCP-managed processes.

### process_logs
Returns bounded recent stdout/stderr events.

### stop_process
Terminates an MCP-managed process tree.

## Git

- `git_status`
- `git_diff`
- `git_log`
- `git_add`
- `git_commit`
- `git_restore` (requires `confirm=true`)

## Verification

### verify_project
For a Node project, detects and runs available scripts in this order:

```text
lint
-> typecheck
-> check
-> test
-> build
```

Stops after the first failed step.

## Browser

- `browser_open`
- `browser_click`
- `browser_fill`
- `browser_snapshot`
- `browser_screenshot`
- `browser_close`

By default only `localhost`, `127.0.0.1`, and `::1` are allowed.

## Observability

### audit_tail
Reads recent redacted NDJSON audit events from `.runtime/audit.ndjson`.
