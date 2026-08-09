# Agent instructions

Always talk and write in ISO 24495-1 Plain Language English.

NEVER stop with uncommitted or incomplete work in any worktree or non-`main` branch.
ALWAYS review and commit the work, then run `thwip ship --wait` to push it, open its PR, and confirm its merge into `origin/main`; after the merge, fetch `origin`, move to the `main` worktree, fast-forward `main` to `origin/main`, verify that `HEAD` matches `origin/main` and the worktree is clean, and stop there.
