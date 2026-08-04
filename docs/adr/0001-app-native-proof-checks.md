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
repository grants `contents:write` today. The App manifest still requests
`contents:read` and `pull_requests:read`, which is the pre-queue set and is now
wrong: an App registered from that manifest cannot drive a turn or open the
setup pull request.

Holding `contents:write` is not the same as using it to move a branch. Nothing
in the Worker writes a ref. The merge is performed by the repository's
`thwip-merge.yml` under a `THWIP_ENQUEUE_TOKEN` the adopter creates, so the one
credential that can move the branch belongs to the adopter and is revoked
without touching thwip.

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

The cutover this section originally described has not happened, and the
paragraph that described it read as though it had. What is true instead:

`policyRuleset` pins the required `thwip` context to the GitHub Actions
integration, and the `canary-negative-test` bootstrap step refuses to advance
unless GitHub confirms it stored that pin. The workflow the setup pull request
adds, `thwip-required.yml`, is what satisfies it. The App publishes a check run
of the same name on the same commit, so every enrolled repository carries two:
GitHub's, which the branch waits on, and the App's, which is advisory.

Both run the same verifier over the same subject, so the duplication costs
Actions minutes rather than correctness. It also leaves the requirement weaker
than this decision intended: a context pinned to GitHub Actions is satisfied by
any workflow in the repository that publishes a green check named `thwip`,
including one a contributor adds.

Moving the requirement to the App takes three changes together, and none of them
is safe alone. `policyRuleset` and `canary-negative-test` have to pin `thwip` to
the App's integration id. Enrolment has to carry the project from `observe` to
`enforced` before that pin has a publisher, because the App names its check
`thwip / proof (observe)` until then. Every enrolled repository needs its
ruleset rewritten. Until all three land, `thwip-required.yml` stays generated and
stays required.

Rollback first restores and verifies the previous required workflow/ruleset
source, then switches the project back to observe mode. Audit records and
policy versions are append-only and remain available after either transition.
