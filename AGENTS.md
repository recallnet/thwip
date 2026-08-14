# Agent instructions

Always talk and write in ISO 24495-1 Plain Language English.

Finish coherent work and commit it. Do not leave an incomplete change in a
worktree or branch.

If your Thwip identity is active for this repository, review the change and run
`thwip ship --wait`. After the merge, fetch `origin`, fast-forward the `main`
worktree to `origin/main`, and verify that it is clean and at the same commit.

If you cannot use Thwip, push the branch and open a normal pull request. Do not
try to bypass the protected queue. A maintainer can review and sponsor the
change as described in [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- thwip:start -->
Before finishing or merging a change, read `THWIP.md` and follow its CI,
receipt, and Thwip Queue protocol. Do not merge with `gh pr merge` or
the GitHub UI when Thwip Queue is enabled.
<!-- thwip:end -->
