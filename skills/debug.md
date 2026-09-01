# /debug

1. Reproduce the failure.
2. Capture exact error/log/console/network evidence.
3. Locate the smallest relevant code surface using repo_map/search_text/read_range.
4. Identify root cause before editing.
5. Apply a minimal patch.
6. Run the narrowest useful verification first.
7. Run broader verification.
8. Browser-test if user-visible behavior changed.
9. Review git_diff for regressions/unrelated changes.
10. Report root cause, fix, and verification evidence.
