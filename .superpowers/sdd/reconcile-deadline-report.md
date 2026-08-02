# Ending a reconciliation nothing could end

## What was wrong

Attempt `att_2dc5e37e` for pull request 114 entered `Reconciling` and stayed there
for more than twenty minutes past its execution deadline of `2026-08-02T05:06:04Z`.
The five-minute cron fired several times and resolved nothing. `POST /tick` was a
no-op throughout, because the wedged attempt held the lane and no entry was
eligible. Pull request 115 sat `Ready` behind it. An operator cleared it with
`POST /reconcile observed=not-merged`, which was true.

The root cause is that the alarm has no answer for a merge outcome in doubt.
`runAlarm()` maps an expired `execution` deadline to `terminateAttempt` with
`EXPIRED_EXECUTION`, and the reducer refuses that outcome while `outcomeUnknown`
is set:

    if (attempt.outcomeUnknown && event.outcome !== "PROVIDER_FAILURE" && event.outcome !== "INVARIANT_FAILURE") {
      fail("an unknown merge outcome may only be resolved by confirmation or operator ruling");
    }

`store.append` turns that into `{ status: "rejected" }` rather than a throw, and
`runAlarm` then clears the deadline row unconditionally. So every sweep rejected
its own command, deleted the row that would have made it try again, wrote no
event, and left the lane exactly where it found it. Nothing consumes the
`reconcile-merge` outbox item either, so there was no automated path out of
`Reconciling` at all. Only two things could end it: a confirmation that never
came, or a person.

The refusal itself is correct and must stay. A deadline says a run took too long;
it says nothing about whether a merge landed. Concluding "not merged" from a
timeout is the failure that lost four merges from the chain and that
`confirmMergeAbsence` exists to prevent. The deadline can only be the trigger.

## What changed

**`packages/queue-domain/src/reconciliation.ts`** (new). `overdueReconciliation(state, now)`
names the condition: the active attempt, still live, `outcomeUnknown`, with an
execution deadline that has passed. Pure, so the reducer's tests, the control
plane and anyone reading a stored document agree on what it means.

It keys on the attempt's own `executionDeadline` field rather than on a row in the
`deadlines` table, because the alarm burns that row on its first pass. By the time
anybody notices the wedge the row is long gone; the field is not.

**`apps/control-plane/src/queue/deadlines.ts`** (new). `settleReconciliation` takes
a named overdue attempt, runs `confirmMergeAbsence` over GitHub reads it builds
itself, and applies one command. It also carries `GITHUB_READS`, the real reads,
as the default, so the fix works without anything being wired into it from
`index.ts`.

**`apps/control-plane/src/queue/scheduled-tick.ts`**. The tick names the overdue
attempt inside the `withQueueState` transaction it already runs, so a queue with
nothing wedged costs no extra D1 read and GitHub is not consulted at all. When
there is one, it settles it after the transaction (the reads take seconds), takes
the resulting snapshot, and drives the lane from that snapshot in the same pass
rather than waiting five minutes for the next one. It logs what it settled on the
channel `wrangler tail` watches.

## What the queue does with each verdict

All three free the lane.

**merged.** The facts come from the commit, never from the verdict: while a pull
request is open, `merge_commit_sha` holds the test merge GitHub computes for it,
and that value once put a commit `main` never was into chain record 54. The
reducer refuses any tree that is not the candidate it authorized, so a wrong
commit certifies nothing. The entry becomes `Merged`, because it is.

The chain link is not written here. Building and signing a transition record lives
behind `routes.ts` and needs a policy, a proof check run, an evidence bucket and a
signer, none of which the cron holds. The gap exists the moment the merge lands
and the run dies, not when this confirms it; confirming only makes the queue agree
with reality, and `POST /v1/queue/:repositoryId/records` writes the link from the
signed intent and a commit sha, which is the repair built for exactly this and
needs nothing from the attempt.

**not-merged.** The day's actual truth. `confirmNotMerged` defers the entry with a
cooldown and keeps its place, exactly as a merge GitHub refuses does.

**unknown.** The one worth arguing about.

The queue ends the attempt `PROVIDER_FAILURE`, which blocks the entry
`MERGE_OUTCOME_UNKNOWN`, and hands the lane back to everybody else.

Freeing the lane here is not a second write. The write in doubt belongs to this
attempt and this pull request. The attempt is over. The scheduler offers turns to
`Ready` entries and to `Deferred` ones serving a cooldown, so a `Blocked` entry is
not handed another turn by any sweep, and the `merge_operations` row still records
that a write was sent, so a re-entry reads instead of sending. Nothing behind it
can double-merge it either: every following turn pins its own candidate against
the base it reads at the time and re-checks base, head, tree and policy in the
final guard immediately before its own write, and a base that moved outside the
queue pauses it through the push webhook.

Refusing to free it is where we were. One pull request nobody can speak for stops
every unrelated pull request behind it, indefinitely, until a human is paged. That
is the failure mode the durability work was meant to remove, and it costs
everybody to buy nothing.

Two other cases fall into this arm rather than guessing: an attempt that pinned no
head commit, so there is nothing whose presence on the base could answer the
question, and a merge that reads as landed but whose commit cannot be read back or
does not match the candidate.

## What an operator sees

The entry stops in `Blocked` with `MERGE_OUTCOME_UNKNOWN`. `buildCheck` publishes
that on the pull request. The queue keeps moving, and the next pull request takes
its turn on the same sweep. `wrangler tail` carries one line naming the repository,
the attempt and how it settled. If the merge did land, `POST /records` writes the
chain link.

One thing this does not do, because `index.ts` belongs to another change in
flight: the heartbeat's summary log line still reports `ticked/driven/failed` and
not the new `reconciled` count that `tickAllQueues` now returns.

## Verification

Before: `1672 passed`. After: `1680 passed` across 107 files.

New tests failed before the fix for the right reasons: `overdueReconciliation`
could not be imported, and the three settling cases left pull request 114 in
`Reconciling` with the lane held.

    pnpm vitest run     107 files, 1680 passed
    pnpm typecheck      all packages Done
    node scripts/lint.mjs   lint: ok
