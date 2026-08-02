# The sweep revives a deferred entry

## What stopped

PR 118's entry sat `Deferred` with `schedulerEligible` true, `primaryReason` null and
`cooldownUntil` null while the lane was idle. `POST /tick` answered "no eligible entry",
`POST /nudge` answered `LANE_IDLE`, and the five-minute cron changed nothing across forty
minutes. The entry moved when its author force-pushed and GitHub sent a `pull_request`
synchronize webhook, which runs a readiness evaluation, which is the one path that puts a
Deferred entry back to Ready.

## Where the gap was

`eligibleEntries()` in `store.ts` and `snapshot-store.ts` counted a Deferred entry only
when it carried a cooldown:

    entry.state === "Deferred" && entry.cooldownUntil !== null

An earlier investigation read that line, saw a deferred entry past its cooldown treated as
eligible, and concluded the domain layer was fine. It is fine for entries that have a
cooldown. PR 118's had none, so the filter dropped it before `selectNext` ever saw it, and
`nextTurn()` returned null however many times the cron fired.

The other half is where a null cooldown comes from. `AttemptTerminated` with a defer
outcome (`EXPIRED_UNCLAIMED`, `EXPIRED_EXECUTION`, `SUPERSEDED`, `HEAD_MOVED`, `BASE_MOVED`)
set the entry to Deferred and never touched `cooldownUntil`, unlike `OfferExpired` and
`MergeConfirmedNotMerged`, which both carry one. So the queue's own termination path
manufactured the state its scheduler refused to look at.

The two store tests that covered this restated the filter predicate inside the assertion
rather than calling `eligibleEntries()`, so they passed whatever the store happened to do.
They are replaced with tests that call the store.

## The fix

- `eligibleEntries()`, both stores: Deferred competes, cooldown or not. `selectNext` takes
  `now` and reads `cooldownUntil`, so an entry still serving one cannot win the round. The
  filter was applying the same rule a second time and losing the entries that had none.
- `AttemptTerminated` carries an optional `cooldownUntil`; the reducer applies it on the
  defer branch. `commands.terminateAttempt` sends `noClaimCooldownSeconds`, the interval an
  unclaimed offer already serves.

The field is optional because terminations already written carry none. Those entries stay
Deferred with a null cooldown, and the store change is what reaches them.

## An entry deferred for a reason that has not gone away

It is offered the lane, its readiness is re-derived on the turn, and if the reason is still
there the turn ends in another defer that stamps a fresh cooldown. So a repeatedly
forfeiting entry costs one offer per cooldown interval, not one per sweep, and whatever is
behind it takes the lane meanwhile. Never reviving is where the queue was; reviving on
every sweep would be the busy loop.

## Verification

Failing first, on the new tests only:

    Tests  10 failed | 70 passed (80)
    AssertionError: expected [] to deeply equal [ 'e1' ]
    AssertionError: expected [ 'Offered', 'Active' ] to include 'Deferred'

After:

    pnpm vitest run   Test Files 108 passed (108)   Tests 1699 passed (1699)
    pnpm typecheck    Done
    node scripts/lint.mjs   lint: ok

Baseline before the change was 1695 tests across the same 108 files.
