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
`checks:write`, and `statuses:write`, and the readiness derivation refuses to
call a pull request mergeable unless the first three are granted. So a queue
repository grants `contents:write`.

The manifest asked for `contents:read` and `pull_requests:read` and left
`statuses` out, which is the pre-queue set. An App registered from it failed the
diagnostic written beside it. There is one list now, `REQUIRED_APP_PERMISSIONS`
in `app-permissions.ts`, read by the manifest and by the doctor.

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
secrets, and a guard this repository tests. `queue_projects.merge_writer` decides
which of the two writes, per repository, and it defaults to the workflow.

One thing stands between that default and deleting the column. Moving this
repository to the App was tried on 4 August 2026 and GitHub refused the ref
update: `422 Required status check "thwip / turn" is in progress`. The queue
publishes that check green and then writes the branch inside the same request,
and GitHub's rule evaluation has not caught up by the time the write arrives.
The workflow never met this, because it ran in a second workflow that started
only once the required check had concluded — which is what the comment at the
top of `thwip-merge.yml` is about. So the Worker has to wait for the check it
just published to be readable before it moves the branch, and until it does, the
column stays and the default stays.

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

1. Observe. The App publishes the observe name, the workflow publishes `thwip`
   from Actions, the ruleset pins Actions. The repository merges.
2. Enforce, which the proof-mode route already gates on a recent observe-mode
   PASS under the active policy. The App now publishes `thwip` and so does the
   workflow: two green checks, one name, two apps. The pin has not moved, so
   nothing about the merge changes. The route queues a proof reconcile, which
   republishes the App's check on every open pull request.
3. Repin, and read it back. Every open head already carries the App's green
   `thwip`, so nothing goes unsatisfied for an instant.

Setup's last step, `pin-proof-check-to-app`, is step three. It runs after the
branch is already protected and merging, waits while the repository observes, and
says what an administrator has to do. A repository enrolled before the step
existed has every earlier step recorded, so re-running setup reaches this one and
nothing else.

While `thwip` is sourced from Actions the requirement is weaker than this
decision intended: any workflow in the repository that publishes a green check
by that name satisfies it, including one a contributor adds. Step three is what
closes that.

Rollback first restores and verifies the previous required workflow/ruleset
source, then switches the project back to observe mode. Audit records and
policy versions are append-only and remain available after either transition.
