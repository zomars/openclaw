# Task 002 — Small code fix with verification

You are working in an isolated OpenClaw benchmark worktree.

Goal: make the failing benchmark test pass with the smallest maintainable change.

Steps:

1. Inspect the failing test added by `setup.sh`.
2. Run only the narrow test first.
3. Implement the minimal fix.
4. Re-run the narrow test.
5. Summarize the root cause and patch.

Constraints:

- Preserve unrelated changes.
- Do not run full `pnpm test:all` unless necessary.
- Do not restart OpenClaw services.
