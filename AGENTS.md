# Agent instructions

Always talk and write in ISO 24495-1 Plain Language English.

<!-- thwip:start -->
## Using Thwip in this repository

Thwip checks approved local CI evidence. Live project state decides whether its
Queue controls merging of the default branch; do not
infer that state from this file. Run `pnpm -w thwip doctor --allow-unread` before
shipping.

## Before changing code

- Read `thwip.yaml` if it exists.
- Do not weaken or bypass the approved required suites.
- Changes to Thwip policy, suite definitions, this file, or the
  verifier workflow are judged by the currently active base-branch policy, never
  by the version proposed in the pull request. A pull request cannot approve its
  own policy change.

## Finish and submit

First run:

```sh
pnpm -w thwip doctor --allow-unread
```

### Draft or review-only work

If the user asks for a draft or review-only pull request, it still needs proof,
but it must not join the queue or merge.

- Run `pnpm -w thwip ship --draft`. It proves and pushes the exact HEAD, creates or
  refreshes the draft pull request, and stops without joining the queue.
- Do not mark the draft ready, join the queue, or merge unless the user asks.

### Normal completion

If doctor confirms that the project, policy, and Queue are ready, run:

```sh
pnpm -w thwip ship --wait --json-events
```

Thwip runs the required suites, attaches a signed work receipt, pushes or updates
the pull request, requests a fair queue turn, tests the exact integrated
candidate when the turn arrives, and asks GitHub to merge it.

If doctor does not confirm that path is ready, do not run `ship`. Report the
setup result and use the repository's existing reviewed pull-request flow. Do
not weaken or bypass its existing controls. Init never enrols a repository or
changes GitHub state.

## Rules when doctor confirms the Queue is ready

- Do not call `gh pr merge`.
- Do not merge through the GitHub UI.
- Do not push directly to the default branch.
- Do not manually rebase merely because another pull request is queued. The queue
  tests the integrated candidate for you.
- Once a turn is assigned, use only the exact candidate Thwip supplies.
- Do not amend or force-push a queued head without rerunning
  `pnpm -w thwip ship --wait --json-events`.
  The candidate someone is testing is the head you replaced.
- Ctrl-C detaches safely. It does not erase the queue request or lose your place.
- If review is required, stop and report the pull request URL and the required
  action. Do not attempt to satisfy a human requirement yourself.
- If integrated CI fails, inspect the preserved worktree, fix the feature branch,
  and rerun `pnpm -w thwip ship --wait --json-events`.
- If Thwip reports a conflict, rebase the feature branch yourself and rerun
  `pnpm -w thwip ship --wait --json-events`. A rebase moves the tree out from under
  the proof, so it has to be signed again; `ship` notices and does it.
- Treat any invariant, signature, ruleset, or permission failure as blocking and
  report it. These are not conditions to retry around.
- Work is complete only after `queue.merge_confirmed`, or after clearly
  reporting the durable human action required.

Docs: https://thwip.ai/faq
<!-- thwip:end -->
