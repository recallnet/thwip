# App-only adoption: what can move out of the workflows

Read from the code on `main` at 36b6338. Every claim below names the file it came
from.

## 1. Proof verification: the App already does it, and the ruleset forbids it from counting

The App publishes a check run literally named `thwip`:
`apps/control-plane/src/app-proof-verification.ts` sets
`APP_PROOF_CHECK = "thwip"`, and `processAppProofVerification` picks the name from
the project's mode — `thwip` when `proof_check_mode = 'enforced'`,
`thwip / proof (observe)` otherwise. It runs `verifyProof` from
`@thwip/verifier`, the same package `packages/action/src/main.ts` runs, over the
same exact PR head and the same merge-group targets. Both cover `pull_request`
and `merge_group`.

Job one of `.github/workflows/thwip-required.yml` publishes a check run also
named `thwip`, owned by the GitHub Actions integration. Two apps, two check runs,
one name. Neither overwrites the other: GitHub keys a check run by app plus name
plus head, so both sit on the commit at once.

Which one counts is decided by the ruleset, and today it is the Actions one.
`apps/control-plane/src/queue/rulesets.ts` `policyRuleset` writes
`{ context: "thwip", integration_id: GITHUB_ACTIONS_INTEGRATION_ID }`, and
`apps/control-plane/src/queue/bootstrap.ts` step `canary-negative-test` refuses
to advance unless GitHub confirms it stored exactly that pin. So the App's
identically named check satisfies nothing.

Two things stand between here and deleting job one, and they are the same size:

- the required `thwip` context is pinned to GitHub Actions and has to be repinned
  to the App's integration id, in `policyRuleset`, in `canary-negative-test`, and
  for every repository already enrolled;
- new projects default to `proof_check_mode = 'observe'`
  (`migrations/0013_app_native_proof_checks.sql`), so the App publishes
  `thwip / proof (observe)` and never `thwip` until an administrator enforces.
  `POST` on the proof-mode route (`apps/control-plane/src/index.ts:560`) refuses
  to enforce without a recent observe-mode PASS, so enrolment has to sequence
  through observe before the pin can mean anything.

Delete job one without both and the required check has no publisher, which wedges
every merge on the branch. So "the App genuinely covers it" is true of the
verification and false of the requirement. Repinning narrows the trust boundary
rather than widening it — right now any workflow in the repository can publish a
green check named `thwip` and satisfy the requirement — but it is still a change
to who may satisfy a required check, so it is on the decision list.

One small loss when job one goes: the action publishes a per-suite check run per
proven suite (`publishSuiteChecks`, display only, never affects the conclusion).
The App publishes no equivalent.

## 2. Queue enrolment: the webhook already does it

`queueFromPullRequest` in `apps/control-plane/src/index.ts:1357` runs on every
`pull_request` delivery and does exactly what the workflow's "Thwip Queue
authorization" step's `/authorize` call does for enrolment: `requestTurn`,
`evaluateReadiness`, `publishTurnCheckFor`, and `cancel` on close. Its own
docstring says "This is why no workflow needs to enqueue anything". The delivery
is HMAC-verified at `/api/github/webhooks`, so the identity is GitHub's own
signature over a payload the branch under test cannot author.

What the OIDC token buys `/authorize` is one thing. `routes.ts:2434` compares
`claims["repository_id"]` against the path and refuses a token minted elsewhere.
Nothing else on that route reads a claim. The `workflow_ref` and
`job_workflow_ref` checks in `queue/verifier-identity.ts` guard
`candidate-result`, not `authorize`. An installation token is scoped to the
installation and the webhook payload names the repository, so the App's own
identity binds the repository at least as hard.

Three things `/authorize` does that the webhook does not:

- **`proofAccepted: true`.** The workflow asserts it because job one just ran. The
  webhook sets `headProof: "unread"`, so `LOCAL_RECEIPT_MISSING` never fires from
  that path. The App holds the real answer in `proof_verifications`; enrolment
  from the webhook should read the row rather than take an assertion from CI.
- **The GitHub reads.** `requiredCheckState`, `pullRequestGates`, `commitFacts`,
  and the whole `prepare` walk. All are installation-token reads the Worker
  already makes elsewhere. Nothing there needs a workflow.
- **Ticking the scheduler and claiming the offer.** `admit(...)` with
  `tickBucket` and `serverMayClaim`, then `driveLane`. `queueFromPullRequest`
  only drives on `closed`. This is the real gap, and it is a gap in the webhook
  handler, not something the workflow uniquely can do — `driveTurnFor` is already
  module-level and the closed path already calls it.

Conclusion: enrolment can run entirely from the `pull_request` webhook. The
missing pieces are reading the App's own proof verdict instead of a CI assertion,
and calling `admit` plus `driveLane` from the webhook the way `/authorize` does.

## 3. The merge write: contents:write is already required and already granted

The workflow composes the merge commit (`POST /git/commits`) and moves the branch
(`PATCH /git/refs/heads/...`, `force: false`) with `secrets.THWIP_ENQUEUE_TOKEN`,
a credential the adopter creates and pastes into Actions.

For the App to do the same it needs `contents: write` and nothing more. Writing a
commit object and moving a ref are both Contents. And it already has it:

- `queueDoctor` (`index.ts:1020`) lists `contents: "write"` as required and
  reports `canMerge` off it;
- the readiness gate (`index.ts:2344`) refuses unless `contents`,
  `pull_requests`, and `checks` are all `write`, under the comment "writing the
  branch, performing the merge, and publishing the check GitHub requires";
- `driveTurnFor` (`index.ts:1787`) uses `repository_dispatch`, which is
  Contents: write, and says so;
- `managedOwnershipRuleset` (`rulesets.ts:83`) already reads "Only the Thwip App
  may update a managed branch, because the App performs the merge", and names the
  App as the sole bypass actor.

ADR 0001's `contents: read` is stale. The App manifest at `index.ts:1731` still
requests `contents: "read"`, which contradicts the doctor in the same file.

So the permission question is already settled in practice. The question that is
not settled is what changes when the control plane starts *using* it:

- **Today.** A compromised control plane can publish checks, dispatch workflows,
  and open pull requests. It cannot move a branch. The one credential that can is
  a repository secret the adopter owns and can revoke without touching thwip.
- **After.** A compromised control plane can move the default branch of every
  adopting repository. Revocation means uninstalling the App.

The countervailing argument is that today's arrangement puts a branch-write
credential in GitHub Actions, which is the most exposed surface in the design,
and makes every adopter mint and rotate one. Moving the write into the Worker
removes that secret from every repository and puts the fast-forward guard in code
this repository tests rather than in shell inside a customer's workflow.

**This one needs your decision. Nothing has been built for it.**

## 4. Running suites: thwip generates no suite workflow at all, for any profile

`setupPullRequestFiles` emits three files: `thwip-required.yml`,
`thwip-merge.yml`, `thwip.yaml`. None of them runs a suite.

Under `remote`, suites named in `thwip.yaml`'s `remote:` list are proven by the
repository's own existing CI: `packages/verifier/src/remote-suite-settlement.ts`
reads check-run conclusions by check name on the head commit. Thwip neither
generates nor owns that workflow. Under `audited` the same list is re-run in
Actions on top of the device receipt (`packages/policy/src/index.ts`). Under
`fast` and `fresh` no suite runs in Actions.

So the answer to "can a reusable workflow the App dispatches replace it" is that
there is nothing to replace. The suite workflow was always the adopter's own CI.

There is a separate gap worth naming: candidate verification under `remote` is
dispatched as `repository_dispatch: thwip-queue-verify`
(`index.ts:2510`) and this repository holds `.github/workflows/thwip-queue-verify.yml`
to answer it, but `bootstrap-workflows.ts` never generates that file. An adopter
on `remote` gets a dispatch nothing listens to.

**`fast` can reach zero workflow files** once job one, the enrolment step, and the
merge write have moved. Nothing under `fast` needs Actions for anything.
`remote` and `audited` reach zero *thwip* workflow files and keep the repository's
own CI, which they were always going to have.

## What is safe to ship without a decision

- Correcting ADR 0001 and the adopter-facing docs to describe what is actually
  true: the App's `contents` requirement, the required-context pin sitting with
  GitHub Actions, and the rollout step that never happened.
- A test proving an adopter still holding the old workflow keeps working while
  the App publishes the same-named check.

## What needs a decision

1. **The merge write.** Move it into the Worker on the `contents: write` the App
   already holds, or leave it in the workflow behind the adopter's own secret.
   Section 3 is the tradeoff.
2. **The required-context pin.** Repin `thwip` from the GitHub Actions
   integration to the App. Job one cannot be deleted until this happens, and
   enrolment has to sequence observe to enforced before the pin has a publisher.

---

# Part two: what got built

## The sequence for the pin, and why it is that way round

The rule the whole thing turns on: **the pin follows the publisher, never the
other way round.**

`thwip` has two possible publishers. Job one of `thwip-required.yml` publishes it
from GitHub Actions. The App publishes it too, but only where
`proof_check_mode` is `enforced`; in `observe` the App publishes
`thwip / proof (observe)` and never the enforced name. A ruleset pin on the App
while the project observes leaves the branch requiring a check nothing posts, and
every open pull request in the repository is stuck behind it with no way out
except an administrator editing the ruleset.

So the source is no longer a constant. `policyRuleset` takes the project's proof
mode and `proofIntegrationFor` picks the Integration from it: Actions while
observing, the App once enforced. Every step of setup that writes the policy uses
the same rule, and `canary-negative-test` reads back whichever source the payload
used rather than asserting the old one. That is what makes every intermediate
state safe rather than only the endpoints.

The order, per repository:

1. **Install, enrol, observe.** The App publishes `thwip / proof (observe)`. The
   workflow publishes `thwip` from Actions. The ruleset pins Actions. The
   repository merges.
2. **Enforce.** `proof_check_mode` observe to enforced, gated on a recent
   observe-mode PASS under the active policy, which is the rule the proof-mode
   route already had. The App now publishes `thwip`. So does the workflow. Two
   green checks, one name, two apps. The ruleset still pins Actions, so nothing
   about the merge changes. The route already queues a `proof_reconcile`, which
   republishes the App's check on every open pull request, so the App's `thwip`
   is green on every open head before anything moves.
3. **Repin.** Rewrite the policy with the App as the source of `thwip`, and read
   it back. Every open head already carries the App's green `thwip`, so nothing
   goes unsatisfied for an instant.
4. Only now may job one be deleted.

Reversible at every point: step 3 back to Actions works while the workflow is
still there, step 2 back to observe works while the pin is still Actions.

## Where that lives

Setup gained one step, `pin-proof-check-to-app`, and it is the **last** one,
after `record-genesis`. That placement is the load-bearing detail:

- A repository that has not enforced still finishes enrolment. The queue is
  enabled and observing, the branch is protected, merges work on the workflow's
  check, and the step waits with a sentence saying what an administrator has to
  do. Enrolment answers 202 rather than 200, which is honest: adoption is not
  finished while the required check comes from an unpinned Actions workflow.
- A repository enrolled before the step existed has every earlier step recorded
  in `bootstrap_progress_json`, so `nextBootstrapStep` returns the new one and
  re-running setup does exactly the repin and nothing else. That is the migration
  path for the repositories already live, and it needs no separate script.
- Nothing runs on deploy. `runBootstrap` is only reached from the bootstrap
  route, which an administrator POSTs. No live ruleset changes until somebody
  asks.

`bootstrapCheckRuns` now publishes both contexts as neutral configuration
evidence on the base tip while the policy is disabled. GitHub offers an App as
the expected source of a context only where the App has recently posted a check
by that name; that was already true of `thwip / turn` and had to become true of
`thwip`.

## What was worse than the report said

**The App manifest was wrong in three places, not two.** It asked for
`contents: read` and `pull_requests: read`, and it omitted `statuses` entirely,
while `queueDoctor` in the same file requires all four at write and computes
`canMerge` from two of them. An App registered from that manifest fails the
diagnostic written beside it. The cause is two lists; there is one now
(`app-permissions.ts`), read by both.

**`remote` and `audited` never worked for any adopter, and the missing workflow
was the smaller half.** `queue_projects.verifier_json` names who may say "the
integrated candidate passed". The column has existed since migration 0005 and
**no code path ever wrote it**. So `authorize` refused every remote merge with
`NO_PINNED_VERIFIER` before it ever reached the dispatch, and `candidate-result`
answered 409 to the verdict that would have cleared it. This repository's row was
typed into D1 by hand during the manual enrolment, which is why the gap survived
review: the one repository anyone tested on had the column filled in.

**The verifier workflow had this repository's suite list baked into it.** A
template that copied it would have run `lint typecheck test` in every adopter's
repository regardless of policy, and any verdict covering a different set is
refused as `CANDIDATE_SUITES_INCOMPLETE` — a refusal the workflow could neither
predict nor fix. The suite names come from the dispatch now, composed by the
control plane from the activated policy. Reading them from the candidate checkout
was the obvious alternative and is wrong: a pull request could shrink its own
suite list.
