# Queue single-path onboarding and cutover

This is the operator runbook for the App-native Queue described in
[ADR 0001](adr/0001-app-native-proof-checks.md). It has two purposes:

1. give every new repository one supported setup path; and
2. move the Thwip service and already-enrolled repositories onto that path
   without building a second migration runtime.

The cutover is deliberately human-guided. Repository rulesets are sensitive
administrative state, and the runtime App does not hold `Administration: write`.
The dashboard renders exact changes, a repository administrator applies them,
and Thwip reads back everything GitHub exposes before advancing.

## The steady state

A correctly enrolled repository has all of these properties:

| Area | Required state |
| --- | --- |
| GitHub App permissions | Checks, Contents, Pull requests, and Commit statuses: write; Metadata: read |
| GitHub App events | `check_run`, `check_suite`, `member`, `membership`, `organization`, `pull_request`, `push`, `repository`, and `team` |
| Queue writer | The installed Thwip App, using `Contents: write` |
| Merge shape | A merge commit whose first parent is the base the queue verified |
| Queue rulesets | `Thwip Queue Ownership` and `Thwip Repository Policy` |
| Required checks | `thwip` for the proof and `thwip / turn` for the queue turn |
| Repository workflows | `thwip-required.yml` and `thwip-queue-verify.yml`; no merge or drain workflow |
| Repository secret | No queue merge or enqueue token |
| Policy source | Organization defaults, unless the repository deliberately adds a `thwip.yaml` override |

`Administration: write` is not required. It would remove the manual ruleset
steps, make bypass actors readable, and help automate a large fleet, but it
would also give the permanently installed runtime App broad authority over
unrelated repository settings. This path keeps that authority with a human
administrator.

Historical signed records may still name an old merge method. That parser is
audit compatibility, not an available setup or runtime option.

## Before onboarding any repository

1. Install the Thwip GitHub App on the repository.
2. Approve any pending permission upgrade. Installing the App in the past is
   not enough when the registration has since gained `Contents: write`,
   `Pull requests: write`, or `Commit statuses: write`.
3. Confirm the live App registration subscribes to every event in the table
   above. Updating the manifest does not update an existing registration or
   installation by itself.
4. Run:

   ```sh
   thwip doctor --repo OWNER/REPOSITORY --branch DEFAULT_BRANCH
   thwip queue doctor --repo OWNER/REPOSITORY --branch DEFAULT_BRANCH --json
   ```

   Do not continue past a missing permission, missing event, inaccessible
   repository, missing policy, or unexpected required-check publisher.
5. Inventory the live rulesets and `.github/workflows`. Stop and remove or
   disable any other automatic branch writer, including GitHub's merge queue or
   an Actions merge workflow. Preserve unrelated review and status-check
   controls; GitHub layers those alongside the two Thwip rulesets.

## The one new-repository path

Run `thwip queue setup --repo OWNER/REPOSITORY` to print the same guided path
for a coding agent. The product flow is:

1. Select the organization defaults. Choose the repository override only when
   this repository intentionally needs a different policy.
2. Run `thwip queue setup --write` in the repository. Review and commit the
   generated `THWIP.md` plus the bounded pointers added to existing agent
   instructions.
3. In the dashboard's **Set up** tab, select **Set up the queue**. Thwip opens
   `Set up Thwip Queue` from `thwip/setup` containing the required proof and
   candidate-verifier workflows. It omits `thwip.yaml` by default.
4. Review and merge that pull request under the repository's existing controls.
   No Thwip ownership or enforcement is active yet.
5. Select **Continue setup**. Apply the generated disabled policy payload, then
   continue again. Thwip publishes bootstrap checks, adds their source pins
   while the policy remains disabled, and reads the stored pins back.
6. Open a real pull request. Confirm that `thwip / workflow`,
   `thwip / proof (observe)`, and the queue checks describe the expected
   decision while the repository still merges under its existing controls.
7. After a recent observed proof passes, enforce the App proof check in the
   dashboard. Reconcile open pull requests so their current heads carry the App
   check. Continue setup, replace `thwip / workflow` with App-owned `thwip` in
   the still-disabled policy, and let Thwip verify the stored source pin.
8. Check the explicit observation confirmation and select **Begin enforcement**.
   Apply the generated changes in the displayed order: ownership first, active
   policy second. The queue enters `canary` before this handoff and becomes
   `enforced` only after both live rulesets match.
9. Compare the live bypass lists with the exact expected lists displayed by the
   dashboard. The policy has no bypass actors. Only the Thwip App bypasses the
   ownership rule. Confirm the comparison and continue.
10. Verify one real pull request reaches `queue.merge_confirmed` and that the
    resulting base commit is the App-authored merge commit recorded by Thwip.

The activation states mean exactly this:

| State | Meaning |
| --- | --- |
| `observe` | The queue reports decisions but cannot write; existing repository controls remain authoritative. |
| `canary` | The administrator explicitly began the ownership handoff; the App writer is enabled, but setup is not yet complete. |
| `enforced` | The active ownership and policy rulesets were read back and accepted. |

Do not apply the proof-gate replacement before the App publishes `thwip`, and do
not activate queue ownership before that replacement is verified.
Observe mode publishes `thwip / workflow` from Actions and
`thwip / proof (observe)` from the App; the final policy replaces the workflow
context with App-owned `thwip` while the policy remains disabled. Reversing that
order creates a required check with no publisher; activating before the
replacement makes the queue depend on the workflow job that is calling it.

## Existing repositories

There is no legacy bridge or automated migration engine. Convert each existing
repository in a short, reviewed maintenance window:

1. Drain or pause the old queue and stop new merges.
2. Record its current rulesets, required checks, bypass actors, active pull
   requests, and automatic merge workflows.
3. Make the App permission and webhook preflight pass.
4. Remove competing merge mechanisms such as GitHub's `merge_queue` rule,
   `.github/workflows/thwip-merge.yml`, and
   `.github/workflows/thwip-drain.yml`. Remove `THWIP_ENQUEUE_TOKEN` after the
   workflow that used it is gone.
5. Follow the new-repository path above. Existing proof and verifier workflows
   may make the setup pull request a small or no-op content change; it still
   supplies the reviewed bootstrap boundary and must use the expected branch
   and title.
6. Re-enable merging only after observation, ruleset readback, bypass
   confirmation, and one App-authored test merge all pass.

Do not delete or rewrite historical attestations. Do not translate old selector
values into new options: the new runtime has no writer, backend, or merge-method
selector.

## Cutting over the Thwip service itself

Thwip is the special case because the repository being protected also ships
the service performing the protection. It must not depend on an unproven new
writer to merge the change that introduces that writer.

Treat the combined cutover pull request as the last merge made through the old
path, then use this order:

1. Before merging, update the live GitHub App registration and approve the
   installation permission upgrade. Run both doctor commands against every
   actively queued repository. In particular, prove the App has
   `Contents: write` and receives `pull_request`, `push`, and `check_run`.
2. Drain the Thwip queue so the cutover pull request is the only remaining
   writer operation. Freeze other merges and keep a repository-administrator
   session available as break-glass access to disable a ruleset.
3. Merge the cutover pull request through the currently deployed path. As soon
   as it lands, pause the Thwip lane and deploy the new Worker from `main`.
   Expect a maintenance window: the pull request removes the old repository
   merge workflows, and the new Worker does not call their callback routes.
4. Do **not** apply migration 0023 yet. The new Worker ignores the old selector
   columns, so leaving them in place preserves the option to roll back the
   deployment while the App writer is being proved.
5. Put the Thwip repository through the same dashboard bootstrap as any other
   existing repository. If the old required-check ruleset prevents the setup
   pull request from merging while the lane is paused, a repository
   administrator may temporarily disable that old ruleset, merge the reviewed
   setup pull request, and immediately continue the staged replacement. This is
   one-time break-glass work, not a runtime fallback.
6. Keep Thwip in `observe` and validate a real pull request. Then begin
   enforcement, apply ownership before policy, confirm bypass actors, enforce
   the App proof publisher, reconcile open heads, and apply the final source
   repin.
7. Resume the lane and prove one Thwip pull request is merged and recorded by
   the App. Also complete the same generic proof on a non-self-hosted repository
   before declaring the rollout healthy.
8. Only after the new Worker and both repository proofs are healthy, run:

   ```sh
   pnpm --filter @thwip/control-plane run migrate:staging
   ```

   Migration 0023 drops `merge_writer`, `backend`, and `merge_method` from
   `queue_projects`. It is marked `after-worker` for this reason. Applying it is
   the rollback boundary: an older Worker that still reads those columns cannot
   be redeployed afterward without a forward schema repair.

## Failure handling

- Before migration 0023, pause affected lanes, disable the generated ownership
  and policy rulesets with repository-admin authority, and roll back the Worker
  if necessary. Restoring the old repository workflows requires reverting the
  cutover commit; do not recreate tokens or add a hidden fallback path.
- After migration 0023, fix forward. Do not deploy a Worker that reads the
  removed columns.
- If ownership is active and the App cannot write, pause the lane and disable
  ownership before attempting any branch recovery.
- If a required check has no publisher, disable the Thwip policy ruleset first,
  correct the publisher or source pin, observe a real pull request, and repeat
  the enforcement handoff.

The completion evidence is a healthy doctor report, exact live ruleset and
bypass readback, a recent App proof PASS, and an App-authored merge with a valid
signed transition record. A green setup response by itself is not sufficient.
