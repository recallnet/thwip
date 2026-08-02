# One lane, one run

## The defect

`thwip-merge.yml` set its Actions concurrency group to
`thwip-merge-${{ github.event.client_payload.pullRequestNumber || github.event.workflow_run.head_sha }}`.

That group names a pull request. The lane names a base branch. One pull request at
a time holds a branch's lane, is integrated against the current base, verified and
merged, and nothing else merges meanwhile; a group keyed per pull request puts two
pull requests in two groups and lets two runs drive one lane.

On 2 August 2026 pull requests 117 and 119 both pinned base `1511515c1241` and
landed on two different bases. Pull request 114 did the same. The merge commits
carried trees no suite had run, and the attestation refused to sign records for any
of them, which is how it was noticed.

Pull request 123 stopped that race corrupting a merge: the ref update is
non-fast-forward-checked, so a merge whose base moved is refused. The race itself
survived. Two runs still competed, one wasted a turn, and the loser failed loudly.

## The group

```yaml
concurrency:
  group: thwip-merge-${{ github.repository }}
  cancel-in-progress: false
```

The base ref is not in it, on purpose. Two triggers reach this workflow:

- `repository_dispatch` (`thwip-queue-turn`), whose `client_payload` carries a
  pull request number and nothing else.
- `workflow_run`, whose payload exposes a base ref only through
  `pull_requests[0].base.ref`, which is empty for pull requests from forks.

Concurrency is evaluated before any step runs, so the workflow cannot look the
base up. Any expression reading the base therefore resolves for one trigger and
not the other, and two triggers for one lane land in two groups. That is the
original bug spelled differently, and it is exactly the failure mode where a group
keyed on something absent silently stops serialising.

Keying on the repository holds every lane in the repository in one group. A
repository queuing onto two base branches merges a little slower and never merges
twice at once. Correctness over throughput, and GitHub's group namespace is
already repository-scoped so `github.repository` is a literal that is always
defined.

It still does the job the old group was added for: the drain re-runs every blocked
check at once, each of those fires a merge run, and only one of them runs.

## cancel-in-progress: false

Cancelling is unsafe at one specific point. A run past the ref update has moved the
branch and has not yet reported to the queue. Kill it there and the branch has
moved with no transition record, which is a merge nobody can audit, the one outcome
this queue exists to prevent.

Runs do not pile up in exchange. Each run asks the queue once and exits; the
waiting loop was removed when the queue took over driving turns. GitHub holds a
single pending run per group and cancels the rest, so a burst of redundant triggers
collapses to one. A turn nobody claimed is offered again by the queue, and the
drain re-drives checks blocked by an outage. The queue re-dispatches; nothing waits
forever.

## The other workflows

**`thwip-required.yml`** (`pull_request`, `merge_group`): no concurrency, correct as
is. It verifies a proof for one head commit, publishes a check, and moves no ref.
It is also a required check, so a concurrency group would let one run cancel
another, and a cancelled required check is not a success: the pull request would be
blocked forever by a check that never runs again. Nothing here needs exclusion.

**`thwip-queue-verify.yml`** (`repository_dispatch`): no concurrency, correct as is.
It checks out a pinned candidate tree, runs the suites, and reports a verdict keyed
by candidate sha. It moves no ref. The queue dispatches it only for the pull
request holding the turn, so at most one is meaningful at a time, and a duplicate
is idempotent. Grouping verification with the lane would be wrong twice over: it
would make a stale dispatch queue behind a live verification, and verification is
not the thing being serialised.

**`thwip-drain.yml`** (`schedule`, `workflow_dispatch`): `group: thwip-drain`,
`cancel-in-progress: false`. Correct as is. Repository-wide and constant, so two
scheduled drains cannot overlap. It re-runs failed checks and moves no ref itself,
and cancelling a half-finished drain would leave some blocked checks re-run and
others not, for no gain.

**`thwip-release.yml`**: `group: thwip-release`, `cancel-in-progress: false`.
Repository-wide and constant, same shape as the drain.

**`apps/control-plane/src/queue/bootstrap-workflows.ts`** ships a copy of
`thwip-merge.yml` in the setup pull request, and it carried the same per-pull-request
group. Every repository adopted since has been running the race. Fixed, and the
drift test now holds the generated lane to the live one.

## The lint

`scripts/workflow-lint.mjs` gains the rule, so this shape cannot come back quietly.

A workflow whose source touches `git/refs/heads` moves a branch, which is what a
merge is. Such a workflow must:

1. declare a `concurrency` block,
2. give it a non-empty `group`,
3. build that group only from literals and repository-wide context
   (`github.repository`, `github.repository_id`, `github.repository_owner`,
   `github.workflow`), and
4. state `cancel-in-progress: false` explicitly, because a lane that relies on a
   default is a lane whose author did not decide.

Rule 3 is what catches the defect. Any `github.event.*` reference in the group
varies with the trigger, and a group that varies with the trigger is not a lane.
The error names the offending expression.

The detection is structural rather than a filename list, so a new workflow that
moves a ref is covered the day it is written.

`scripts/lint.mjs` now reports workflow problems as lint failures rather than
throwing an uncaught error, so the message a reader gets is about their workflow.

## Verification

The new rule against the old workflow, then against the new one:

```
$ git stash push -q .github/workflows/thwip-merge.yml
$ node scripts/lint.mjs
lint: .github/workflows/thwip-merge.yml: moves a branch ref, so its concurrency group must name the queue, but it varies with ${{ github.event.client_payload.pullRequestNumber || github.event.workflow_run.head_sha }}
lint: 1 problem(s)
exit=1

$ git stash pop -q
$ node scripts/lint.mjs
lint: ok
exit=0
```

`pnpm vitest run`, before:

```
 Test Files  120 passed (120)
      Tests  1794 passed (1794)
```

after:

```
 Test Files  120 passed (120)
      Tests  1804 passed (1804)
```

Nine cases in `scripts/workflow-lint.test.mjs` and one drift case in
`bootstrap-workflows.test.ts`.

`pnpm typecheck`: all four packages clean.

`pnpm lint`: `lint: ok`.
