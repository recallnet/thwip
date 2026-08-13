# Queue onboarding and steady state

This is the operator runbook for the App-native Queue described in
[ADR 0001](adr/0001-app-native-proof-checks.md). Every new repository follows
one supported setup path.

Setup is deliberately human-guided. Repository rulesets are sensitive
administrative state, and the runtime App does not hold `Administration: write`.
The dashboard renders exact changes, a repository administrator applies them,
and Thwip reads back everything GitHub exposes before advancing.

## The steady state

A correctly enrolled repository has all of these properties:

| Area | Required state |
| --- | --- |
| GitHub App permissions | Checks, Contents, Pull requests, Commit statuses, and Workflows: write; Metadata: read |
| GitHub App events | `check_run`, `check_suite`, `member`, `membership`, `organization`, `pull_request`, `push`, `repository`, and `team` |
| Queue writer | The installed Thwip App, using `Contents: write` and `Workflows: write` for CI-definition changes |
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
   `Pull requests: write`, `Commit statuses: write`, or `Workflows: write`.
   Workflows write is narrower than Administration and exists so the sole App
   writer can merge reviewed changes to `.github/workflows` without a bypass.
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
3. In the dashboard's **Queue** tab, select **Set up the queue**. Thwip opens
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

The completion evidence is a healthy doctor report, exact live ruleset and
bypass readback, a recent App proof PASS, and an App-authored merge with a valid
signed transition record. A green setup response by itself is not sufficient.

## Failure handling

- If ownership is active and the App cannot write, pause the lane and disable
  ownership before attempting any branch recovery.
- If a required check has no publisher, disable the Thwip policy ruleset first,
  correct the publisher or source pin, observe a real pull request, and repeat
  the enforcement handoff.
- Schema changes fix forward. Do not deploy a Worker that reads columns a
  migration has already dropped.

## Removing a repository

GitHub App repository selection is the project lifecycle. Before removing an
enforced repository from the App, a repository administrator must disable or
remove `Thwip Queue Ownership` and `Thwip Repository Policy` while the App can
still read the repository. The runtime App does not hold the Administration
permission needed to remove those rulesets after access is revoked.

Then use **Manage repositories on GitHub** in Thwip Settings and remove the
repository from the installation. An installation that covers all repositories
must first change to selected repositories. Thwip re-reads the complete GitHub
selection, stops new project work, and removes the project's policies, proofs,
queue state, signed records, grants, metrics, and stored evidence. Selecting the
repository again creates a new disabled project; it does not restore the old
project.
