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

The App adds only `checks:write` to its existing read access. It keeps
`contents:read`, `metadata:read`, and `pull_requests:read`; it does not need
Actions, repository Administration, production secrets, or a user OAuth token
to publish checks. It subscribes to `pull_request`, `merge_group`, `check_run`,
`check_suite`, and the existing projection/policy events.

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
observe-mode PASS exists. Administrators then pin the required `thwip` context
to the thwip App and verify a fresh check before removing the old workflow.

Rollback first restores and verifies the previous required workflow/ruleset
source, then switches the project back to observe mode. Audit records and
policy versions are append-only and remain available after either transition.
