# The turn check that never arrived, and the merge that was never going to land

Two defects, one visible consequence. The App published `thwip / turn` for some
pull requests and not others, and the queue then asked GitHub to merge one of the
ones without it and wedged on the refusal.

## Why the publish was skipped

`turnCheckUpdates` (apps/control-plane/src/queue/turn-check.ts) publishes only
what changed. That is deliberate: republishing for every entry after every
command would be one GitHub request per entry per check. It rests on every writer
of queue state publishing what it changed.

`queueFromPullRequest` in apps/control-plane/src/index.ts did not. It called
`runOnQueue` with no publisher argument, on both the `closed` path and the
placement path. It is the first writer for almost every entry, because GitHub
delivers the `opened` webhook before the required workflow runs. So the webhook
moved the entry from absent to waiting and said nothing, and `/authorize` arrived
a few seconds later to find the entry already waiting, changed nothing, and
therefore published nothing either.

A pull request the lane later offered got its check on the waiting-to-holds
transition and looked fine. One that only ever waited got no check at all.

The live evidence says exactly this.

- PR 120 opened at 07:15:15. The authorize step in run 30737452020 answered
  `{"authorized":false,"reason":"WAITING_FOR_TURN","queuePosition":4}` at
  07:15:31, so the entry was placed and stayed waiting. Its head
  `77f1e113df64` carries `thwip`, `thwip / lint`, `thwip / test`,
  `thwip / typecheck` and `thwip / proof (observe)` and no run named
  `thwip / turn`. PR 114 at `5dc41b4eaffc` is identical.
- PR 118's current head `c138f8413f9f` carries `thwip / turn` (success, "It is
  this pull request's turn") published at 08:45:21 and `thwip / proof (observe)`
  at 08:44:49, and nothing from GitHub Actions at all. No authorize call had run
  against that commit. The check appeared on the offer, which is the only
  transition that published.

So the check arrived exactly when the turn changed and never otherwise, which is
the behaviour the missing publisher produces.

The fix moves the publisher to module scope beside `driveTurnFor` and passes it
from both webhook paths. The `closed` path needs it for its own reason: cancelling
frees the lane and the settle that follows offers it to whoever is next, and that
pull request's check has to say so.

## What the queue now does when a required check is missing

The merge itself is a PUT made by `.github/workflows/thwip-merge.yml` once
`/authorize` with `prepare: true` hands back an operation id. Before that call
returns an operation the queue has signed a merge intent, stored it, walked the
attempt to merge-ready and started the confirmation clock. GitHub then answered
405 because a required check was absent, and the attempt held the lane with
everything behind it stopped.

Both facts were readable first. `/authorize` now reads
`/repos/{repo}/rules/branches/{branch}` for the contexts the branch requires and
the head's check runs and commit statuses, and refuses with
`REQUIRED_CHECK_MISSING` and a sentence naming the check:

> this branch requires "thwip / turn", which nothing has published on this
> commit. GitHub would refuse the merge, so the queue is not asking for it.

Only the certain cases refuse. A required context with no run cannot pass, and one
that concluded badly goes on refusing until something re-runs it. A run still in
progress is left alone, because it may yet pass and refusing on it would turn
every ordinary race into a refusal. Rules that could not be read say nothing about
this head, so an unreadable answer goes ahead rather than stopping the queue every
time GitHub has a bad minute.

## Verification

Baseline on `main`: 108 files, 1695 tests, green.
After: 110 files, 1703 tests, green. `pnpm typecheck` and `node scripts/lint.mjs`
both clean.

Both new test files were red first:

- `apps/control-plane/src/queue/turn-check-publication.test.ts`, 2 failing
  against the unfixed `index.ts` (confirmed by stashing the fix and re-running).
- `apps/control-plane/src/queue/required-checks-before-merge.test.ts`, the
  refusal case failing with `authorized: true` and an operation id.
