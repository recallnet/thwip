# fresh demo, PR #2 — report

Date: 2026-08-01. Repo `recallnet/thwip-test`, id `1319756073`, project `qp_thwiptest_main`.

## Status

Goals 1 and 2 are **not met**. Goal 3 stands from the earlier run. The
`verified-merge` record does not exist and the chain is still empty:

```
$ node vlc-test.mjs        # vlc2.mjs, REPO=1319756073
links 0  epochStartsAt 0
signaturesChecked 0
findings 0
sequences
```

The stall is understood and half of it is fixed in code. What remains is not a
code problem and I cannot resolve it without the operator.

## Why `queue_runners` was empty

`thwip ship` never called `POST /v1/queue/:repositoryId/runners/heartbeat`. Only
`thwip queue work --watch` announced a device, and that command has no checkout
to integrate, so nobody ever ran it during a ship. `ship`'s `awaitTurn` port
slept five seconds and posted `/tick`. Under `fresh`, `capabilityFor` reads
`queue_runners`, finds nothing, and `foldCapability` withholds the offer with
`AGENT_OFFLINE` — forever. Sixty polls later `runShip` gave up with
`INTERNAL_FAILURE`. The wait and the thing that would end the wait were in two
different commands.

Fixed on branch `ship-announces-presence` (pushed, not merged): `runShip` calls a
new `announcePresence` port before `await-turn` and before `execute-turn`.
`/claim` reads the same presence, so both steps need it. The port is a no-op
under `fast` and `remote`, which never read `queue_runners`.

Two commits, both red-green:

- `b15315f` — announce before waiting and before claiming.
  `ship-io.test.ts` asserts the call order `announcePresence, awaitTurn,
  announcePresence, executeTurn`.
- second commit — report a refused announcement. `realHeartbeat` never throws,
  so a 403 was silent, and that silence is why this looked like a slow queue for
  hours. `ship` now prints `ship.presence-refused` on every waiting turn.

`pnpm vitest run` 1641 passed, `pnpm typecheck` clean, `node scripts/lint.mjs` ok.

## The remaining blocker: two GitHub accounts on one machine

With the fix in, ship now says exactly what is wrong:

```
ship.presence-refused: AGENT_OFFLINE https://thwip.recall.net refused this
machine's presence (403) for device SHA256:nXERD2khQGOHccKTXtLUpsivMtnR2X1BSV6mLOeKfV4
```

The heartbeat route refuses with *that device key belongs to somebody else, or
has been revoked*, because:

- `gh` on this machine is `4ndr3wxh1ll` (GitHub id `264261678`). The signing key
  `~/.ssh/id_ed25519` (`SHA256:nXERD…`) is registered to that account, it signed
  PR #2's head proof, and `device_keys` binds it to `264261678`.
- `~/.config/thwip/session-token` is a session for **`andrewxhill`** (GitHub id
  `370259`, `prn_gh_370259`). `/v1/me` confirms it, and so does
  `~/.config/thwip/session-token.andrewxhill`, which is the same session.
- PR #2 is authored by `4ndr3wxh1ll`, so its entry's sponsor is
  `prn_gh_264261678`. `/claim` refuses any caller who is not the sponsor, and
  the receipt route refuses a key not bound to the caller's GitHub user.

So the machine can sign as `4ndr3wxh1ll` and the queue offers the turn to
`4ndr3wxh1ll`, but thwip has no session for `4ndr3wxh1ll` — no `user` or
`account` row for `264261678` exists at all. Signing in as that account is an
interactive OAuth grant and a first-time account creation, which I will not do
on the operator's behalf.

`andrewxhill` cannot stand in either: the only signing key GitHub lists for
`andrewxhill` is `SHA256:sXpY8H/MvrqO+yiNK8diGPwwUuWcg+jnIzahpRldpvI`, and its
private half is not on this machine. There is no identity here that can both
hold the turn and sign the receipt.

**What the operator has to do:** run `thwip login` and approve the device code in
a browser signed into GitHub as `4ndr3wxh1ll`. Then
`node packages/cli/dist/main.js ship --wait` in `thwip-test` on `fresh-demo-2`
should announce, be offered the turn, claim, verify the assignment, materialize
the candidate, run `lint` and `test`, submit the receipt, and merge.

## Proof the heartbeat path itself works

One real heartbeat, through the API, from the session I hold, with that
principal's own enrolled device id:

```
POST /v1/queue/1319756073/runners/heartbeat  {"deviceKeyId":"key_9c3187c5716b0e0a7bd8614d9db3c15a"}
-> {"holdsOffer":false}
queue_runners: prn_gh_370259 | key_9c3187c5716b0e0a7bd8614d9db3c15a | 2026-08-02T04:43:13.291Z
```

Presence is recorded, and PR #2 stays `AGENT_OFFLINE` because its sponsor is a
different principal. That is the diagnosis, demonstrated rather than argued.

## Defects found, not fixed

1. **The sponsor depends on which path created the entry.**
   `POST /v1/queue/:id/entries` (routes.ts:1192) sets
   `sponsorPrincipalId = body.sponsorPrincipalId ?? who.principalId` — the
   session caller. The `pull_request` webhook (index.ts:~1382) sets it to the
   pull request's **author**. Both PRs here are authored by `4ndr3wxh1ll`, yet
   entry 1's sponsor is `prn_gh_370259` and entry 2's is `prn_gh_264261678`,
   because entry 1 came through ship's `joinQueue` and entry 2 through the
   webhook that started arriving this week. The author is the right answer —
   a fairness share belongs to the person whose work it is — so `POST /entries`
   is the one to correct.

2. **The heartbeat route re-derives readiness onto terminal entries.**
   routes.ts:1310 loops over every entry whose `primaryReason` is
   `AGENT_OFFLINE` and marks it eligible, without checking the entry's state.
   My heartbeat above flipped `entry_1319756073_1` — permanently `Cancelled` —
   to `scheduler_eligible = 1, primary_reason = null`. Inert, because
   `eligibleEntries()` filters on `Ready`/`Deferred`, but the projection now
   asserts something false about a cancelled entry. One state guard fixes it.

3. **`thwip ship` push, already filed.** Unchanged, and not hit this run:
   HEAD already carried a proof matching its tree.

## Written to the database by hand

Nothing. Every write came from the API. The one row I caused is the
`queue_runners` heartbeat above, which the five-minute sweep retires on its own,
plus the eligibility flag defect 2 wrote onto the cancelled entry 1.
