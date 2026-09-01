# AGENTS.md — Vibecode Operating Contract

## Goal

Use the MCP as a local execution harness. The model in ChatGPT performs reasoning; this repository does not run a second LLM.

## Golden workflow

1. UNDERSTAND the user request.
2. INSPECT `PROJECT_SPEC.md`, `AGENTS.md`, repository map, Git status.
3. PLAN the smallest coherent change.
4. IMPLEMENT with targeted edits.
5. VERIFY lint/typecheck/tests/build when available.
6. START the application when runtime behavior matters.
7. BROWSER TEST the affected user flow.
8. REVIEW `git_diff` for unrelated or accidental changes.
9. FIX failures and repeat verification.
10. Report DONE only with evidence.

## Context discipline

- Prefer `repo_map` + `search_text` + `read_range`.
- Do not read the entire repository by default.
- Prefer `apply_patch` for localized modifications.
- Re-read the edited range after important changes.

## Safety

- Never operate outside the configured workspace.
- Never request or print secrets.
- Do not change global Git configuration.
- Do not force-push.
- Do not run destructive system commands.
- Use `delete_path` only when deletion is explicitly necessary.

## Definition of Done

A coding task is done only when the relevant subset is true:

- requirement implemented;
- lint passes;
- typecheck/check passes;
- tests pass;
- build passes;
- runtime starts;
- affected UI flow works in browser;
- no relevant console/network errors;
- Git diff contains no unrelated changes.
