# Deploy integrity: four things that changed underneath a running system

Branch `deploy-integrity`. Four defects, one shape: something moved and nothing
noticed until a person hit it.

Tests: 104 files / 1639 tests on `main`, 108 files / 1670 tests on this branch.
`pnpm typecheck` and `node scripts/lint.mjs` both clean.

| Commit | Defect |
| --- | --- |
| `0ec5322` | Code deployed against a schema that had not been migrated |
| `08d6770` | The App subscribed to fewer events than the code handles |
| `8de7605` | A policy shape change invalidated proofs already signed |
| `753e806` | `/admin/sync` returned 500 after succeeding |

## 1. The database the code runs against

**Chose:** refuse the deploy. Not `/health`.

`/health` can only report a mismatch once the bad Worker is already live and
already answering 500 on the path nobody watches. That is the same position the
four staging deploys were in, with a nicer error page. The deploy is the moment
the two halves are known together, and it is where the other three refusals
already live: build first, and no checkout behind `origin/main`.

The ordering is a per-migration fact, so each migration declares it in its
header and `scripts/schema-guard.mjs` reads the answer. 0018 is the one that
proves a blanket rule would be wrong: it adds the unique index that refuses a
second record for a merge, and it needed the Worker carrying the constraint
catch to already be live. It declares `after-worker`, so predeploy names it and
lets it through. Everything else declares `before-worker` and stops the deploy
while it is pending.

Two ways the guard refuses to go quiet. A migration with no declared order
refuses the deploy rather than defaulting, so a new file cannot arrive silent. A
`wrangler d1 migrations list` output that says neither "these are pending" nor
"nothing is" refuses too, because reading an unparseable answer as "clean" is
exactly how a check reports success while checking nothing.

## 2. The App's subscription against the router

**Chose:** a diagnostic in the doctor, plus a test over the code.

A test alone cannot see the defect. The manifest already declared all ten
events, correctly, and the installed App still delivered only `check_suite` for
months. What was wrong lived on GitHub, not in the tree, so only something
reading the live installation can find it. `/admin/queue/doctor` and
`/v1/queue/:id/doctor` now report `subscribedEvents`, `handledEvents`,
`deadHandlers` and `receivesEveryHandledEvent`, and the doctor is already where
an operator looks when the queue is not moving.

An installation object with no `events` field reads as unknown, not healthy.

The test covers the half the diagnostic cannot: it reads every event the code
branches on out of `index.ts`, `app-proof-verification.ts`,
`policy-activation.ts` and `queue/external-push.ts`, and fails when one is not
declared. The manifest takes the list rather than repeating it, and the test
fails on a literal array reappearing there.

Events the control plane mints for its own queue, `policy_reconcile` and
`proof_reconcile`, are declared separately. Listing them as webhook events would
report them as delivered by an App that never sends them, which would make the
diagnostic lie in the reassuring direction.

## 3. Proofs signed under a policy that moved

**Chose:** say so. Not a grace window on the old digest.

Keeping a superseded digest acceptable means certifying a merge against a
document nobody activated, which is the one thing the proof exists to rule out.
Deleting the dead fields was right and the new digest is the real one.

So the check now says what to do. `checkSummary` carries
`nextActionFor(outcome, "check")` for any non-`PASS` outcome the vocabulary
names, which for `POLICY_NOT_ACTIVE` reads "This proof was signed under a policy
that is no longer active. Run thwip run again." That sentence has existed the
whole time, written once for all three surfaces. The check never read it.

A test walks every reason code, so one added later cannot land on a pull request
with no instruction attached.

## 4. `/admin/sync`

The proof-check pass reads open pull requests, needs a permission the
installation may not hold, and threw out of the handler. A finished reconcile
came back as a 500.

`syncInstallations` in `admin-sync.ts` separates the two. Projection and policy
decide `reconciled`. The proof-check pass runs after, fails on its own, and is
recorded beside the reconcile that completed. One installation's refusal does
not stop the next. The status stays 200 with `degraded` naming whether anything
was skipped.

A 403 is reported as `APP_PERMISSION_DRIFT`. `GithubApiError` carries the status
so a caller can tell a refusal from a bad gateway without parsing prose, and
`reasonForGithubFailure` maps only 403, because a 502 dressed as a setup
instruction sends an operator to fix a permission that was fine.

## What was not done

The App's actual permissions on GitHub are unchanged; granting Pull requests and
Statuses is an org owner's action. The doctor now names the missing event
subscriptions as well as the missing permissions, so the next person has the
whole list in one place.
