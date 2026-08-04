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
