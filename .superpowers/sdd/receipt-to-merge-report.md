# Receipt to merge

The last unfinished step: an attempt reached `RECEIPT_SUBMITTED` on `recallnet/thwip-test`
pull request 2 and never moved again.

## What is supposed to happen after `RECEIPT_SUBMITTED` under `fresh`

The receipt alone verifies the attempt. No candidate verdict is required on top of it, so the
missing piece was never the verifier dispatch.

That is settled by three things, not by reading intent into a document.

`requiresRemoteVerification` in `apps/control-plane/src/queue/candidate-verdict.ts` returns
false for `fresh`, so `/authorize` never asks a pinned verifier for a verdict. The plan says
why at task 5.4 and §5.0: `fresh` runs the integration on the developer's machine and has no
fallback to Actions, so demanding an Actions verdict would refuse every `fresh` merge for want
of a workflow the profile does not use. `audited` is `fresh` plus that second execution.

The reducer's own transitions do the rest. `RECEIPT_SUBMITTED` is followed by
`VerificationStarted` and `VerificationCompleted`, and `walkToMergeReady` issues both itself
inside one queue transaction, passing `verifiedResultDigest ?? localRun.receiptDigest` as the
result. Under `fresh` that is the device's receipt. Nothing external supplies a verdict.

`localRunEvidenceFor` is the gate, and it is a real one: no accepted receipt for this attempt
and this tree, no merge. `walkToMergeReady` cannot be called without the value it returns.

So the sequence is: receipt accepted → `driveLane` dispatches `thwip-queue-turn` →
`thwip-merge.yml` calls `/authorize` with `prepare` → the walk verifies on the receipt, signs
the intent and mints the operation → the workflow merges and reports to `/merged` →
`signVerifiedRecord` writes the `verified-merge` record. Every piece of that existed. Nothing
drove it more than once.

## Why nothing happened

Three defects, at three layers.

**One dispatch, fire and forget.** The receipt route calls `driveLane` once and ignores the
result. Nothing else in the system would ever drive a device-only lane again: `tickAllQueues`
skipped every device-only repository outright, and its holder lookup only ever saw `Offered`
and `Active`. A dropped dispatch, or a run that answered before some other fact settled, left
the attempt holding the lane until its execution deadline with nobody willing to ask again.
The live repository shows exactly this: three `thwip-merge` runs, each refused, and no fourth.

**`/nudge` reported `LANE_IDLE` for a lane that was held.** A second defect, and the reason
the first was invisible to every operator tool. The route picked the holder itself with
`state === "Offered" || state === "Active"` and returned before `driveLane` — which does
understand `Verifying` and `MergeGuard` — was ever reached. Under `fresh`, `Verifying` is the
whole window in which the merge still has to be written, so the one manual recovery for an
unmerged attempt refused to look at the only state it gets stuck in. Two predicates for one
question.

`POST /tick` answering `no eligible entry` is not a defect. That is the scheduler declining to
offer a turn while the lane is held, which is correct, and it says nothing about the holder.

**A push under a running turn poisoned it.** The root cause of the live refusal. The entry
followed the push — `admit` calls `entryHeadChanged` — and the attempt did not, because the
reducer holds a pinned candidate immutable. So the assignment kept naming a tree GitHub no
longer integrates. `thwip ship` asking again was handed that same stale assignment back by the
claim route's idempotent early return, ran the stale tree, and signed an honest receipt for the
wrong tree. The queue accepted it, and then refused every merge with
`INTEGRATION_RECEIPT_TREE_MISMATCH` — a refusal no push and no operator could clear.
`HEAD_MOVED` is the reducer's own answer for a source that moved and nothing was reaching it:
`commands.entryHeadChanged` was called, `commands.terminateAttempt` with `HEAD_MOVED` was not.

Evidence, from `recallnet/thwip-test` run 30780535739:

```
authorize: http 200
{"authorized":false,"reason":"INTEGRATION_RECEIPT_TREE_MISMATCH",
 "detail":"the accepted receipt is about a different tree than the one being merged"}
```

## What changed

`apps/control-plane/src/queue/scheduled-tick.ts` — the five-minute sweep drives a device-only
lane whose entry is `Verifying` or `MergeGuard`, the same split `driveLane` makes. It still
leaves a lane the device is running on alone.

`apps/control-plane/src/queue/routes.ts` — `/nudge` lets `driveLane` decide who holds the lane
and reports what it decided. One predicate.

`apps/control-plane/src/queue/queue-operations.ts` — `admit` terminates a running attempt
`HEAD_MOVED` when the head moves under it. That defers, so the place in line is kept and the
next turn is taken against what is there now. An unclaimed offer pins nothing and is left
alone; so is a merge already sent to GitHub, because only confirmation may say what it did.

Nothing weakened the gate. `localRunEvidenceFor` is untouched, and the paired test asserts that
the same recovered path merges nothing and writes no chain link when no receipt was accepted.

## Verification

`pnpm vitest run`: 122 files, 1806 tests before; 122 files, 1813 tests after. `pnpm typecheck`
and `node scripts/lint.mjs` both clean.

The headline test fails on the pre-change sources with the production symptom — the entry holds
at `Verifying` instead of reaching `Merged` — and passes after.
