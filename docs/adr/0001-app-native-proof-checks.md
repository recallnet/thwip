# ADR 0001: App-native proof checks

## Status

Accepted for issue #53.

## Decision

The thwip GitHub App owns proof verification and publishes the required
`thwip` check for pull requests and merge groups. The verifier evaluates the
exact event subject, uses the same shared verifier package as other surfaces,
and executes no repository code.

Configuration resolves in this order:

1. built-in schema and safety constraints;
2. organization proof defaults managed in the dashboard;
3. an optional `thwip.yaml` from the active default-branch policy.

Repository fields override organization defaults. Arrays replace arrays and
mapping sections merge by field. Configuration from the candidate pull
request is never used to approve that pull request.

Each evaluation creates an immutable database row and a service-signed audit
record containing the subject, base, policy digest and version, verifier version, individual
outcomes, check-run id, and timestamp.

Publishing checks adds only `checks:write` to the App's read access. It needs no
Actions permission, no repository Administration, no production secret, and no
user OAuth token to publish a check. It subscribes to `pull_request`,
`merge_group`, `check_run`, `check_suite`, and the existing projection/policy
events.

Thwip Queue, which arrived after this decision, asks for more. `driveTurnFor`
fires a `repository_dispatch`, enrolment opens the setup pull request, and both
are Contents. `queueDoctor` requires `contents:write`, `pull_requests:write`,
`checks:write`, and `statuses:write`. Ruleset reads use the App's existing
`metadata:read` permission. Ruleset writes remain a repository-administrator
operation because GitHub gates them behind the coarse `administration:write`
App permission, which also grants unrelated repository-management authority.
The readiness derivation refuses to call a pull request mergeable unless its
runtime permissions are granted.

The manifest asked for `contents:read` and `pull_requests:read` and left
`statuses` out, which is the pre-queue set. An App registered from it failed the
diagnostic written beside it. There is one list now, `REQUIRED_APP_PERMISSIONS`
in `app-permissions.ts`, read by the manifest and by the doctor.

Enrolment still owns the ordering and the payload. At each ruleset phase it
returns an exact create or update command, waits for a repository administrator
to apply it, and reads the visible configuration back before advancing. GitHub
does not expose bypass actors to a caller that cannot edit the ruleset, so setup
requires an explicit human confirmation that those actors match the generated
payload before it activates. This is the one field the least-privilege App
cannot independently verify.

The Worker uses that write. The merge was shell in the adopter's
`thwip-merge.yml` under a `THWIP_ENQUEUE_TOKEN` they created, which put a
branch-write credential in the most exposed surface in the design and left the
guard the scheme rests on as untested shell in somebody else's repository. The
Worker composes the merge commit on the base the queue pinned and moves the ref
without force, which is what makes GitHub refuse a base that moved. `force` is
typed to the literal `false`, so a forcing caller cannot be written.

The cost is stated plainly: a compromised control plane can move the default
branch of every adopting repository, and revocation means uninstalling the App.
What it buys is one branch-write credential removed from every adopter's Actions
secrets, and a guard this repository tests. `queue_projects.merge_writer`
decides which of the two writes, per repository. Product enrolment writes
`app`; the database default remains `workflow` so an older or manually-created
row cannot silently acquire a second writer.

One thing stands between that default and deleting the column. Moving this
repository to the App was tried on 4 August 2026 and GitHub refused the ref
update: `422 Required status check "thwip / turn" is in progress`. The queue
publishes that check green and then writes the branch inside the same request,
and GitHub's rule evaluation has not caught up by the time the write arrives.
The workflow never met this, because it ran in a second workflow that started
only once the required check had concluded — which is what the comment at the
top of `thwip-merge.yml` is about. The Worker now retries only that exact 422,
with bounded backoff and the same non-forcing ref update each time. The column
and its workflow default remain for existing projects so deploying this change
cannot silently give one queue two writers; fresh product enrolments choose the
App explicitly.

We could instead request `administration:write`. That would make setup one-click,
let the App create and update every staged ruleset, and let it verify bypass
actors without human attestation. It would also make permission upgrades and
large fleets easier to operate. We do not choose it by default because the
permission is permanent installation authority broader than queue operation,
including sensitive repository settings. Teams that value automated fleet
provisioning over that larger trust boundary could revisit the decision or use a
separate, short-lived setup integration.

## Rationale

App ownership removes a repository workflow from the trust boundary, gives
teams a zero-file adoption path through organization defaults, and makes one
installation upgrade apply across repositories. The optional repository
override preserves reviewable, project-specific policy for existing setups.

The Enterprise-only organization-ruleset/workflow design remains a possible
future opt-in for teams that explicitly need that control plane. It is not the
default because it adds platform and repository-management requirements that
make ordinary adoption harder.

Fork pull requests are read through the base repository's Pull Requests and
compare APIs. The service reads commit metadata and the proof carrier only; it
does not fetch a fork worktree, execute candidate code, or expose a secret to
candidate-controlled code.

Each event performs bounded GitHub metadata/key reads and one Worker verifier
evaluation. It consumes no Actions runner minutes and stores no source, logs,
or artifacts. Webhook delivery is retried through the queue, and scheduled
reconciliation repairs missed deliveries. If the App is removed, its
permission upgrade is incomplete, the bundle cannot be resolved, or audit
signing fails, the required check remains missing, failing, or in progress
rather than producing success.

## Rollout and rollback

Projects begin in `observe` mode and receive a distinct
`thwip / proof (observe)` check. Enforcement cannot be enabled until a recent
observe-mode PASS exists, which the proof-mode route checks before it writes.

The required `thwip` context moves from GitHub Actions to the App, and the order
is the whole problem.

The App publishes `thwip` only where `proof_check_mode` is `enforced`; in
`observe` it publishes `thwip / proof (observe)` and never the enforced name. A
pin on the App while a project observes leaves the branch requiring a check
nothing posts, and every open pull request stuck behind it. So the pin follows
the publisher: `policyRuleset` reads the source from the project's proof mode,
and `canary-negative-test` reads back whichever source the payload used.

Per repository:

1. Merge the setup pull request under the repository's existing controls. It
   contains the two queue workflows and inherits organization defaults; a
   `thwip.yaml` is included only when the administrator explicitly selects a
   repository override.
2. Create the generated disabled, unpinned policy. Thwip reads it back and
   publishes the bootstrap checks, then returns the generated source-pinned
   update. The administrator applies it while enforcement is still disabled.
3. Thwip verifies both pins, enables the queue in `observe`, and leaves ownership
   and policy enforcement disabled. A real pull request proves the App proof and
   queue checks while the repository's existing controls remain authoritative.
4. The administrator explicitly begins enforcement. Thwip first persists
   `canary`, which keeps the App able to write during the manual handoff, then
   returns ownership followed by active-policy payloads. After reading both back
   and confirming the exact bypass lists, it records `activation_state` as
   `enforced`. The Thwip policy adds no review requirements; GitHub layers the
   repository's existing review controls alongside the queue checks.
5. Enforce the App proof check, which the proof-mode route already gates on a
   recent observe-mode PASS under the active policy. The App now publishes
   `thwip` and so does the workflow: two green checks, one name, two apps. The pin
   has not moved, so nothing about the merge changes. The route queues a proof
   reconcile, which republishes the App's check on every open pull request.
6. Apply the generated repin and let Thwip read it back. Every open head already
   carries the App's green `thwip`, so nothing goes unsatisfied for an instant.

Setup's last step, `pin-proof-check-to-app`, is step six. It runs after the
branch is already protected and queue-enforced, waits while the App proof check
observes, and returns the exact update an administrator applies. A repository
enrolled before the step existed has every earlier step recorded, so re-running
setup reaches this one and nothing else.

While `thwip` is sourced from Actions the requirement is weaker than this
decision intended: any workflow in the repository that publishes a green check
by that name satisfies it, including one a contributor adds. Step six is what
closes that.

Rollback first restores and verifies the previous required workflow/ruleset
source, then switches the project back to observe mode. Audit records and
policy versions are append-only and remain available after either transition.
