# Demonstrating `fresh` on recallnet/thwip-test

Status: one of the three goals reached. The demonstration stops on a GitHub App
permission that only a human org owner can grant.

| Goal | Result |
| --- | --- |
| 1. A merge producing a `verified-merge` chain record | Not reached |
| 2. That chain verifying clean | Not reached — the chain is still empty |
| 3. A merge attempt with no receipt refused | Reached |

## Goal 3, on the record

The queue offered PR #1 the turn (attempt `att_f857b34b-177c-479c-b3e7-5d8a14c80bbc`).
Before any device receipt existed, `thwip-merge` asked to merge. Run
[30731315029](https://github.com/recallnet/thwip-test/actions/runs/30731315029):

```
authorize: http 200
{"authorized":false,"enforcing":true,"activationState":"enforced",
 "reason":"INTEGRATION_ASSIGNMENT_MISSING",
 "detail":"this profile runs the integration on a device, and no device was ever assigned this attempt",
 "entryId":"entry_1319756073_1","operationId":null}
queue did not authorize a merge: INTEGRATION_ASSIGNMENT_MISSING
```

No `operationId` was issued, the workflow did not call GitHub's merge endpoint,
and PR #1 is still open. The gate is `localRunEvidenceFor` in
`apps/control-plane/src/queue/local-run-gate.ts`.

## What blocked goals 1 and 2

`POST /v1/queue/:repositoryId/claim` resolves the integrated candidate itself
rather than trusting the caller, through
`GET /repos/recallnet/thwip-test/pulls/1` on the installation token. The
installed App holds `checks: write`, `contents: write`, `members: read`,
`metadata: read` and nothing else, so that read answers:

```
queue QUEUE_COMMAND_FAILED: GitHub /repos/recallnet/thwip-test/pulls/1 -> 403:
{"message":"Resource not accessible by integration", ... "status":"403"}
```

The App's own doctor already names this: `missingPermissions` is
`{pull_requests: write, statuses: write}` and `canMerge` is false. Under `fresh`
the device claim is the only path to a receipt, so no receipt can be produced,
no `verified-merge` record can be written, and the chain stays empty
(`/v1/queue/1319756073/chain` returns `{"epochStartsAt":0,"links":[]}`).

Fixing it means editing the `thwip dev` GitHub App definition to request the
Pull requests permission and accepting the upgrade on installation 149708815.
That is a GitHub App configuration change, so it was left for a human.

## Defects found

1. **Migrations 0020 and 0021 were never applied to staging, and the Worker that
   reads them was deployed anyway.** Both files carry a `DEPLOY ORDER` header
   saying they must land first. Every `/authorize` for a `fresh` or `audited`
   repository returned `500 QUEUE_COMMAND_FAILED` with
   `D1_ERROR: no such table: queue_runners`, which is the whole reason PR #1's
   entry sat in `Requested` with no reason. `recallnet/thwip` runs on `fast`,
   which never reads `queue_runners`, so nothing noticed. Applied with
   `wrangler d1 migrations apply thwip-staging-wnam --remote`.

2. **The App has never been granted the permissions the product says it
   requires.** Consequences beyond goal 1: zero `pull_request` webhook
   deliveries have ever arrived (82 `check_suite`, and no `push` either), so
   `queueFromPullRequest`, `externalPushFromWebhook` and the policy-push sync
   have never run in this deployment. Everything that works today works because
   the workflows in `recallnet/thwip` call `/authorize` directly.

3. **A missing App permission surfaces as an opaque 500.** The GitHub 403 in
   `/claim` propagates as `QUEUE_COMMAND_FAILED`, "The queue could not complete
   that. Nothing was changed." The readiness vocabulary already has
   `APP_PERMISSION_DRIFT` and the doctor already computes the answer; the claim
   path does not consult either.

4. **There is no product path that bootstraps a repository into the queue.**
   `BOOTSTRAP_STEPS` in `apps/control-plane/src/queue/rulesets.ts` names seven
   steps including `merge-setup-pr`, and `nextBootstrapStep` / `mayActivate` are
   pure functions with tests and no caller anywhere in the codebase. Nothing
   opens a setup pull request, nothing creates a ruleset, nothing advances
   `bootstrap_progress_json`. Bootstrapping thwip-test was manual.

5. **The generated ruleset requires a context nothing publishes.**
   `policyRuleset()` pins `Thwip / Merge`. The App publishes `thwip / turn`
   (`turn-check.ts`) and the proof check is `thwip`. `recallnet/thwip`'s live
   ruleset requires `thwip` and `thwip / turn` — neither is what the generator
   would write. An activated generated ruleset would block every merge on a
   check that never arrives.

6. **A key enrolled through `POST /v1/devices` can never be used.** That
   endpoint mints `key_<32hex>` ids. The CLI addresses a device by the SSH
   fingerprint of the key it signs with (`main.ts`, `deviceKeyId:
   key.fingerprint`), and `resolveVerificationBundle` only ever accepts keys
   GitHub publishes for the signer, caching them with `key_id = fingerprint`.
   So the enrollment endpoint's own ids are unreachable from the CLI and its
   keys are unusable for proofs.

7. **`/authorize` reads runner presence for the pull request's author, while the
   turn is offered to the entry's sponsor.** When the two principals differ —
   an entry placed by `thwip queue join --sponsor`, or a bot pull request with a
   human sponsor — `capabilityFor` looks up a principal that has no runner and
   writes `AGENT_OFFLINE` over an entry whose sponsor is heartbeating. The only
   thing that corrects it is the heartbeat route's offline-to-online transition,
   which a machine that never went away does not produce.

8. **`thwip queue doctor` sends the wrong credential.** The plan is
   `requiresAdmin: true` against `/admin/queue/doctor`, but `apiAuthHeader()`
   prefers the session token and only falls back to `THWIP_ADMIN_TOKEN` when the
   session file is absent, so the command answers `{"error":"unauthorized"}` for
   anyone who is signed in. The same request with the operator token succeeds.

9. `thwip ship` still amends HEAD and pushes without force (already filed). Hit
   on every iteration; worked around with `git push --force-with-lease`.

## What was changed

On `recallnet/thwip-test`:

- `.github/workflows/thwip-required.yml` and `.github/workflows/thwip-merge.yml`,
  copied from `recallnet/thwip` and committed to `main` (`fe61beb`). The verifier
  step uses `recallnet/thwip@main` instead of `./`. The candidate-verify and
  drain workflows are not needed: `fresh` runs the integration on the device, so
  `requiresRemoteVerification` is false for it.
- Repository secret `THWIP_ENQUEUE_TOKEN`, set to this machine's `gh` token.
- Ruleset "thwip proof verification" (id 20217367), created by hand through the
  GitHub API because the product has no path that provisions one. It mirrors
  `recallnet/thwip`'s: `thwip` pinned to GitHub Actions (15368) and
  `thwip / turn` pinned to the thwip App (4419870), on `~DEFAULT_BRANCH`.
- Branch `fresh-demo` re-shipped several times; head is now `0cbd6e4`.

On staging:

- Applied migrations 0020 and 0021 with `wrangler d1 migrations apply --remote`.
  No rows were written to the database by hand.
- Enrolled one device key through `POST /v1/devices`
  (`key_9c3187c5716b0e0a7bd8614d9db3c15a`, `demo-2026`, GitHub user 370259)
  before finding defect 6. It is unused and can be revoked.

No thwip source was modified, so the suite is untouched.

## The identity problem, for whoever picks this up

This machine has two GitHub accounts in play. `gh` and `~/.ssh/id_ed25519`
belong to `4ndr3wxh1ll` (264261678), who authored PR #1 and whose key signs the
proofs. The thwip browser session, and therefore the CLI session token, belongs
to `andrewxhill` (370259), who sponsors the queue entry. The CLI signs the proof
and the integration receipt with the same key and addresses the device by that
key's fingerprint, so `thwip ship --wait` cannot drive a turn here: `/receipt`
requires the device key's owner to be the caller.

The fresh turn was therefore driven by a script at
`.../scratchpad/fresh-turn.mjs` that imports the CLI's own `runFreshTurn`,
`materializeCandidate`, `signReceipt` and `parseKeySet` and passes the enrolled
key id. Every decision still comes from `packages/cli`. It reached `/claim` and
stopped on the 403 above.
