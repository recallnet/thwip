# Project lifecycle in-place cutover

Issue #398 makes GitHub App repository selection the only project lifecycle.
The cutover uses the existing D1 database, R2 bucket, and GitHub App key. Do not
create replacement storage or rotate credentials for this migration.

## Safety model

The lifecycle-aware Worker binds every current write to an exact project
incarnation. Removal creates a durable release request before cleanup, blocks
new work, and deletes project-scoped D1, Durable Object, queue, and R2 state in
bounded retryable passes. Re-selection waits one hour for GitHub installation
tokens minted before removal to expire, then creates a fresh disabled project.

R2 writes create a durable exact-object intent before `put()`. Live writers
renew that intent every minute. Cleanup retries a returned or failed write
immediately and treats a writing intent as abandoned only after its fifteen
minute lease plus a further one-hour grace period. A failed object deletion
keeps the intent for the next bounded pass.

This is an application release boundary, not a physical capability rotation.
Cloudflare allows an HTTP client to keep a Worker request open without a fixed
wall-time limit. #398 does not require old code kept alive across deployments to
remain a supported writer forever. The cutover therefore uses a one-hour
compatibility window after the lifecycle-aware deployment instead of replacing
the database, bucket, and App key.

## Phase 1: additive preparation

1. Apply `0029_terminal_comment_priority.sql` and
   `0030_github_repository_lifecycle.sql` as one before-worker phase.
2. Deploy the exact canonical `main` Worker.
3. Confirm signed `/health` reports the exact build,
   `projectLifecycle.maintenanceMode: false`, and
   `schema.capabilities.projectLifecycle: true`.
4. Let the bounded project-id backfill finish. Do not continue until signed
   `/health` reports `projectLifecycle.backfillReady: true`.
5. Confirm at least one hour has passed since
   `projectLifecycle.workerActivatedAt`.

The first three steps are already complete on staging. Cleanup remains
fail-closed until the finishing schema is installed.

## Finish the schema in place

Use the dedicated short-lived D1 migration credential and the guarded migration
command from a clean checkout whose full SHA equals freshly fetched
`origin/main`. Never use raw Wrangler to skip a barrier.

1. Run the guarded migration command. It must select only
   `0031_finish_github_repository_lifecycle.sql`.
2. Migration `0031` verifies the one-hour compatibility window and fresh
   backfill counts, enters maintenance atomically, rebuilds the repository-keyed
   tables with mandatory project incarnation ownership, removes the obsolete
   tombstone schema, and leaves maintenance on.
3. Confirm `/health` and `/v1/schema` still work, every other route returns
   `503`, queue messages are delayed, scheduled work stops, and
   `projectLifecycle.cleanupReady` is true.
4. Run the guarded migration command again. It must apply exactly
   `0032_private_agent_feedback_foundation.sql` and
   `0033_verifier_protocol_v3.sql`.
5. Deploy the exact current canonical `main` Worker again. Confirm signed
   `/health` reports the same full build SHA, maintenance mode, the `0032` and
   `0033` capabilities, and a `workerDeploymentId` different from
   `verifierV3PredeployId`. This proves the deployment happened after `0033`.
6. Run the guarded migration command once more. It must select only
   `0034_reopen_after_project_lifecycle.sql`. Only the final statement in
   `0034` clears maintenance.
7. Confirm signed `/health` reports:
   - the exact expected build SHA;
   - `projectLifecycle.maintenanceMode: false`;
   - `projectLifecycle.cleanupReady: true`;
   - `schema.capabilities.lifecycleReopened: true`.
8. Confirm the release drainer removes pending project-scoped state while
   preserving unrelated repositories and shared organization, user, and billing
   records.
9. Remove and re-select one test repository through the GitHub App. Confirm it
   returns after the one-hour quarantine as one fresh disabled project with no
   old policy, proof, queue, grant, metric, chain, or evidence state.

There is no open-traffic window between `0031` and `0034`. The Worker-level
maintenance gate is the continuous fence. Never clear `maintenance_mode` by
hand.

## What is deliberately not part of this cutover

- no D1 export, import, replacement database, or database deletion;
- no R2 copy, replacement bucket, or bucket deletion;
- no GitHub App private-key rotation;
- no capability-evidence JSON or retirement timestamp;
- no permanent repository tombstone.

Keep issue #398 open until the in-place schema finish and live remove/re-select
evidence are complete.
