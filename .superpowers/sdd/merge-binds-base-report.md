# The merge binds the base it was verified against

## The defect

The queue signs a merge intent pinning a triple: base sha, head sha, and the tree
the merge will produce. That tree is what the candidate was verified against. It
then called GitHub's merge-pull-request API, which takes an expected head and no
expected base, and merges onto whatever the base branch is at that moment.

Three merges on 2026-08-02 landed on a base their intent never named:

| PR  | pinned base  | actual base  | pinned tree  | actual tree  |
| --- | ------------ | ------------ | ------------ | ------------ |
| 114 | 33db87a6cffe | 57cf6b458461 | 81bf88450cc5 | 829288649240 |
| 117 | 1511515c1241 | 15a6f3ab4e41 | 75d2b700498b | 1c6c26cbec37 |
| 119 | 1511515c1241 | 812d3a86653c | 932b18fb862f | ef9853e15fb4 |

`checkMergeConsistency` refused to sign a record whose merged tree is not the
candidate tree, so no chain record was written for any of them and `/repair`
refuses them with `MERGE_NOT_AUTHORIZED`. The attestation was honest at its own
expense. Nothing in this change touches that gate.

## What GitHub actually offers

Checked by introspection and by running the calls against a throwaway repository,
not from documentation.

- `PATCH /repos/{o}/{r}/git/refs/{ref}` has `sha` and `force` and no
  expected-old-value parameter. Without `force` it refuses any update where the
  branch is not an ancestor of the new commit.
- GraphQL `MergePullRequestInput` has `expectedHeadOid` and nothing for the base.
- GraphQL `MergeBranchInput` has no expected oid at all.
- GraphQL `CreateCommitOnBranchInput` does have `expectedHeadOid`, a real
  compare-and-swap, but takes `fileChanges` and produces one parent. It cannot
  write a merge commit.

So the only base-binding primitive GitHub has is the non-force ref update. It is
not a compare-and-swap on the old value; it is an ancestry check. For a commit
whose first parent is the pinned base, the only branch that is an ancestor of it
is that base, so for this use the two are the same thing.

## What it cost, measured

Run against a scratch repository, four probes:

1. **Base moved.** Commit composed with parents `[B0, head]`, branch moved to
   `B1`, non-force `PATCH` → `422 Update is not a fast forward`. The branch did
   not move. This is the guard.
2. **Happy path.** Same commit composed on the current base → the ref moves, and
   `git/commits/<sha>` returns exactly the message we wrote, including
   `thwip-queue-operation:`. The trailer `external-push.ts` keys on survives.
3. **The pull request.** Within seconds GitHub reported the pull request as
   `merged: true`, `state: closed`, `merge_commit_sha` equal to the composed
   commit. It closes as merged, not merely closed.
4. **Branch protection.** Under an active `required_status_checks` ruleset with
   no bypass actors — the same shape as `recallnet/thwip`'s live ruleset — the
   ref update was refused with `Required status check "probe-check" is expected`
   while the check was absent, and accepted once the check was green on the head
   commit that is the merge's second parent. GitHub evaluates the rule against
   the incoming merge's head parent, exactly as it does for a pull request merge.
   No ruleset change is needed.

The approach holds up. One thing it does not cover.

## Squash

Probe 4 repeated with a squash-shaped commit (one parent, head not an ancestor)
was refused: `Required status check "probe-check" is expected`. The pushed commit
introduces changes with no checks of its own and no head parent to inherit them
from, so a branch that requires checks — which every queue-managed branch does —
refuses it. GitHub also cannot detect the merge, so the pull request would stay
open.

There is no other primitive. The workflow therefore refuses a squash merge with a
named error rather than performing one it cannot bind. A squash repository loses
its merges until this is solved; the alternative is going on merging trees nobody
ran, which is the thing this exists to prevent.

Solving it later means publishing the two required contexts on the composed
squash commit before moving the ref: `thwip` from the merge workflow, which is
Actions and satisfies that pin, and `thwip / turn` from the App. That synthesizes
green checks for a commit that was never independently run, so it wants its own
argument and its own review.

## Also unaddressed

`managedOwnershipRuleset` gives the App `bypass_mode: "pull_request"` over an
`update` rule. A direct ref update is not a pull-request bypass, so a repository
provisioned on the managed backend would refuse this merge. Nothing runs on that
backend today. `recallnet/thwip` carries no such ruleset.

## What now happens when the base moves

1. `authorize` answers with `merge: { baseRef, baseSha, headSha, treeOid,
   parentShas }`, read from the reducer's own attempt, which is immutable once
   the candidate is pinned and is the same triple the signed intent binds.
2. The workflow composes the merge commit from that answer: pinned base as first
   parent, head as second, the verified tree, and the message the queue signs.
3. It moves the branch ref with `force:false`.
4. If the base moved, GitHub answers `422 Update is not a fast forward`. Nothing
   lands. The run reports `BASE_MOVED off <base>` to `/not-merged`, which frees
   the lane, and fails with a named error.
5. The queue offers a new turn against the new base and runs the suites again.
   There is no retry onto a base nobody verified.

## Root cause, and what this does not fix

The base moved because the queue's merge workflow has a per-pull-request
concurrency group, so two pull requests can be mid-merge at once. 117 and 119
pinned the *same* base and landed on two different ones, which is one lane held
by two entries. This change makes that race unable to corrupt a merge. It does
not make the race stop happening.
