# Shipping changes with Thwip

This repository uses Thwip for approved local CI and Queue-controlled merging of
`main`.

## Before changing code

- Read `thwip.yaml`.
- Do not weaken or bypass the approved required suites.
- Changes to Thwip policy, suite definitions, this file, or the
  verifier workflow are judged by the currently active base-branch policy, never
  by the version proposed in the pull request. A pull request cannot approve its
  own policy change.

## Finish and submit

Run:

```sh
thwip ship --wait --json-events
```

Thwip runs the required suites, attaches a signed work receipt, pushes or updates
the pull request, requests a fair queue turn, tests the exact integrated
candidate when the turn arrives, and asks GitHub to merge it.

## Queue rules

- Do not call `gh pr merge`.
- Do not merge through the GitHub UI.
- Do not push directly to `main`.
- Do not manually rebase merely because another pull request is queued. The queue
  tests the integrated candidate for you.
- Once a turn is assigned, use only the exact candidate Thwip supplies.
- Do not amend or force-push a queued head without rerunning
  `thwip ship --wait --json-events`.
  The candidate someone is testing is the head you replaced.
- Ctrl-C detaches safely. It does not erase the queue request or lose your place.
- If review is required, stop and report the pull request URL and the required
  action. Do not attempt to satisfy a human requirement yourself.
- If integrated CI fails, inspect the preserved worktree, fix the feature branch,
  and rerun `thwip ship --wait --json-events`.
- If Thwip reports a conflict, rebase the feature branch yourself and rerun
  `thwip ship --wait --json-events`. A rebase moves the tree out from under
  the proof, so it has to be signed again; `ship` notices and does it.
- Treat any invariant, signature, ruleset, or permission failure as blocking and
  report it. These are not conditions to retry around.
- Work is complete only after `queue.merge_confirmed`, or after clearly
  reporting the durable human action required.

## Reading the queue

```sh
thwip queue status --pr <number>      # where this pull request stands
thwip queue list                      # projected order for main
thwip queue explain                   # what the queue is doing and why
```

Projected order changes after every review and check. There is no permanent
position, and Thwip will not pretend otherwise.

Docs: https://thwip.ai/faq
