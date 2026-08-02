# queue-routes-fixes

Branch `queue-routes-fixes`, off `1511515` (PR 115 merged). Five defects found by
running the queue rather than its tests.

## What changed

| Commit | What |
| --- | --- |
| `3f75e57` | `fix(devices): name an enrolled key by its fingerprint` |
| `b8711f5` | `fix(queue): keep a finished entry finished when readiness is re-derived` |
| `570da4d` | `fix(queue): give a pull request one sponsor and a way back into the line` |

## Defect 1: two sponsors for one pull request

`POST /v1/queue/:repositoryId/entries` sponsored whoever called it; the
`pull_request` webhook sponsored the author. Whichever arrived first set the
sponsor, and under `fresh` the turn is offered to the sponsor while runner
presence is read for that same person, so the queue could wait on a machine
belonging to somebody who was never going to run the turn.

The caller also chose the branch. Nothing checked it against the branch the pull
request targets, and the entry id is scoped per queue document, so naming the
wrong branch put a second entry for one pull request on a second queue — the
"two entries" half of the report.

Both facts now come from GitHub through a new route dependency,
`pullRequestPlacement(env, repositoryId, pullRequestNumber)`, which returns the
author's GitHub user id and the base ref, or null. The route refuses rather than
guesses: 502 when the pull request cannot be read, 409 `WRONG_QUEUE` when the ref
does not match, 409 `AUTHOR_NOT_ACTIVATED` when the author has no principal here
(the same answer the webhook already gives).

The dependency is required, not optional, so a deployment cannot wire the routes
without it.

## Defect 2: `/authorize` checked the wrong person's machine

It resolved a principal from `authorGithubUserId` and used it both to read runner
presence and as the sponsor it admitted with. The scheduler offers the turn to
the entry's sponsor, so where the two differed the gate waited on the wrong
laptop.

`/authorize` now reads the entry first and takes its sponsor. The author derives
the sponsor only where there is no entry yet. Cost is one row read of the
document the route is about to open anyway.

## Defect 3: a cancelled entry could never be queued again

The reducer discards `QueueRequested` for an entry that already exists, and the
store turns that no-op into `{"status":"duplicate"}` whatever idempotency key was
sent. That rule is what keeps one pull request in one place; it is wrong for a
terminal entry, so closing and reopening a pull request made it permanently
unqueueable.

`requestTurn` in `queue-operations.ts` is now the only way an entry is placed. It
looks at the entry, and when the entry is `Merged` or `Cancelled` it re-requests
with `resetOrdinal: true` under a key varied by the ordinal being replaced. The
reducer already supports `resetOrdinal` (added in `e29c178`); no reducer change
was needed. Three callers use it: the join route, the merge gate through `admit`,
and the `pull_request` webhook, because a reopened pull request is placed by
whichever arrives first.

`commands.requestQueue` grew an optional `resetOrdinal`, set by `requestTurn` and
nothing else.

## Defect 4: readiness re-derived onto terminal entries

The heartbeat route matched entries on `!schedulerEligible && primaryReason ===
"AGENT_OFFLINE"` and never looked at the state. Cancelling leaves both fields as
they were, so a cancelled entry matched and came back claiming to be schedulable
with nothing blocking it.

The five-minute sweep in `scheduled-tick.ts` has the same shape from the other
direction — it matches on `schedulerEligible` and would write `AGENT_OFFLINE`
onto a cancelled entry. Both now skip `TERMINAL_ENTRY_STATES`.

### Reducer change another agent should make

The single-place fix belongs in `packages/queue-domain/src/reducer.ts`, which is
not mine to edit. `ReadinessEvaluated` writes `entry.primaryReason`,
`entry.secondaryReasons` and `entry.schedulerEligible` **before** it checks
`entry.state !== "Merged" && entry.state !== "Cancelled"`. Those three
assignments should sit behind the same guard, so a terminal entry ignores a
readiness evaluation entirely instead of only ignoring the state transition. The
two route-level guards fix the paths that exist today; that guard closes the
class.

## Defect 5: keys issued by `POST /v1/devices`

Not a signing problem. The enroller supplies its own public key and holds the
private half, so it can sign. The identifier was wrong.

`device_keys.key_id` holds a fingerprint everywhere it is read:

- the receipt route resolves the signing key with `WHERE key_id = ?` against
  `receipt.deviceKeyId`, which the CLI fills with `key.fingerprint`;
- `deviceKeyClaimedByAnother` checks ownership and revocation by `key_id`;
- `verification-bundle.ts` caches GitHub-published keys with
  `key_id = fingerprint`.

Enrolment minted `key_<32 hex>` instead. An enrolled key therefore answered none
of those lookups, and — because `idx_device_keys_fingerprint` is unique — its row
also blocked the bundle from ever caching the same key under the id the readers
do use, so the GitHub-published copy of an enrolled key stopped working too.
Enrolling a device is what broke it.

The write moved to `enrolDeviceKey` in `runners.ts`, which stores `key_id =
fingerprint` and is covered against the same storage the readers use.
`wellFormedDeviceKeyId` still accepts the old `key_` shape for machines enrolled
while it was minted.

One thing this does not fix: proof verification builds its key set from the
signer's GitHub-published signing keys. A key enrolled here and not published on
GitHub still cannot verify a proof, by design in `verification-bundle.ts`. If
enrolment is meant to be a proof path, that is a separate decision about where
key trust comes from, not a bug in this route.

## Left for the CLI

`thwip queue join` sends `{ pullRequestNumber, sponsorLogin }` and no `headSha`
(`packages/cli/src/queue-commands.ts`). The route has always required `headSha`
and has never read `sponsorLogin`, so the command answers 400. It is unchanged by
this branch and it belongs to whoever owns the CLI.

`sponsorPrincipalId` and `sponsorGithubUserId` are gone from the request body
with the caller that set them. No shipped client sent either. plan.md 8.1's
human sponsor for a bot pull request has no route until one is built on the
author.

## The sweep's reconciled count, asked for and not added

The coordinator asked for `reconciled` to go into the scheduled heartbeat's log
line in `index.ts`, so a fleet repeatedly settling merges out of `Reconciling` is
visible in `wrangler tail`.

It is not here to add. PR 117 (`reconcile-deadline`) is still open, `origin/main`
is `1511515`, and `tickAllQueues` on this base returns `{ ticked, driven,
failed }` with no `reconciled` field. Logging one would print `undefined` and
would not compile against the current signature.

The line to change is `index.ts`'s

    `[queue heartbeat] ticked=${result.ticked} driven=${result.driven} failed=${result.failed}`

and it wants ` reconciled=${result.reconciled}` appended once PR 117 lands.
Whoever merges second should make that edit; it is one line and no test asserts
the log's shape.

## Verification

Baseline on `1511515`: 106 files, 1672 tests, green.

New tests before the fixes: 10 failing in `entry-sponsor.test.ts` and
`runner-heartbeat-route.test.ts`, plus 3 in `runners.test.ts` that could not
resolve `enrolDeviceKey`.

After: `pnpm vitest run` 107 files, 1685 tests, green. `pnpm typecheck` clean.
`node scripts/lint.mjs` ok.
