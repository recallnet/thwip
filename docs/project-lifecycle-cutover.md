# Project lifecycle capability cutover

Issue #398 needs two reviewed releases. Do not combine them into one unattended
deployment. The database cannot prove that an old Worker invocation has ended:
an HTTP Worker can stay alive while its client remains connected.

## Phase 1: prepare and fail closed

1. Apply migrations `0029_terminal_comment_priority.sql` and
   `0030_github_repository_lifecycle.sql` as one contiguous before-worker phase.
2. Deploy the lifecycle-aware Worker while it still uses the existing R2 bucket
   and GitHub App key.
3. Confirm `/health` shows `projectLifecycle.cleanupReady: false`.
4. Confirm removing GitHub App repository access immediately creates a release
   request, hides the project, and rejects new work, but does not delete project
   data.
5. Let the bounded lifecycle backfill finish. Confirm `/health` shows
   `projectLifecycle.backfillReady: true` before scheduling maintenance. The
   Worker does not run backfills while maintenance mode is active.

This phase is backward compatible. It may leave a release request pending. That
is intentional: the request is the fail-closed fence until the remote
capabilities are retired.

## Human cutover

The operator must perform and record every item below. Never put a private key,
API token, or copied evidence bytes in the record.

1. Read `/health` once before maintenance and confirm its signed response uses
   the expected service key and reports `backfillReady: true`. Then set
   `project_lifecycle_rollout.maintenance_mode`
   to `1` in the old D1 database. Confirm `/health` reports maintenance mode,
   `/v1/schema` still works, and every other route returns `503`. Queue messages
   must be delayed and scheduled work must stop.
2. Export the fenced old D1 database with Wrangler. Record the export SHA-256,
   schema SHA-256, and a canonical SHA-256 of per-table row counts. Create a new
   D1 database generation, import the export, and prove `PRAGMA quick_check`
   returns `ok`, `PRAGMA foreign_key_check` returns no rows, and the schema and
   row-count digests match. Keep maintenance mode enabled in the imported copy.
3. Create a new R2 bucket generation.
4. Create a new GitHub App private key.
5. Deploy the exact reviewed Worker with `DB` bound to the new D1 generation,
   `EVIDENCE` bound to the new bucket, and `GITHUB_APP_PRIVATE_KEY` set to the
   new key. Confirm signed `/health` comes from the new D1 database and still
   reports maintenance mode. Perform a temporary D1 round trip in the new
   generation, then remove the temporary row.
6. Delete the old D1 database. A paused old Worker version still holds its old
   binding, so deletion—not a quiet-time estimate—is the capability boundary.
   Prove the old database no longer exists.
7. Drain the old bucket into the new bucket. Preserve every
   existing `project/<project-id>/...` key. Map a legacy
   `org/<org-id>/repo/<repository-id>/...` key to the currently selected project
   only when D1 proves that exact organization owns the repository.
8. Repeatedly copy and delete every object remaining in the old bucket, then
   delete the bucket itself. R2 is strongly consistent and refuses to delete a
   non-empty bucket. A write that wins the race keeps deletion from succeeding
   and is copied on the next pass; a write that loses the race fails because the
   bucket is gone. Migration 0031 records this deletion as retirement of the old
   R2 capability generation. Do not clear an expired `writing` intent before
   that retirement: lease time cannot prove a paused `put()` has stopped. After
   migration 0031, new writes use the new bucket generation and the bounded
   drainer may remove old-generation objects and intents from the copied data.
9. Immediately before deleting the old GitHub App private key, mint one canary
   installation token with it and record the deletion time. Delete the key.
10. Prove the new key can read `GET /app`, and prove a JWT signed with the old key
   receives `401`. Record only key fingerprints and results.
11. Wait at least one hour after deleting the old key. GitHub installation access
   tokens remain valid for up to one hour after they are minted. Prove the old
   canary installation token now receives `401`; only then is the old GitHub
   capability retired.
12. Prove the new bucket accepts and returns a temporary digest-addressed object,
   and prove the old bucket no longer exists. Remove the temporary object.
13. Confirm `/health` serves the exact reviewed build SHA from the new D1
    generation, with maintenance mode still enabled.

Use the dedicated migration credential and the exact database names and IDs
confirmed by the normal production-access preflight. The D1 portion is the
following sequence; store command output in the change record:

```sh
wrangler d1 execute OLD_DATABASE --remote \
  --command "UPDATE project_lifecycle_rollout SET maintenance_mode = 1 WHERE id = 1"
wrangler d1 export OLD_DATABASE --remote --output thwip-d1-cutover.sql
shasum -a 256 thwip-d1-cutover.sql
wrangler d1 create NEW_DATABASE --location wnam
wrangler d1 execute NEW_DATABASE --remote --file thwip-d1-cutover.sql
wrangler d1 execute NEW_DATABASE --remote --command "PRAGMA quick_check; PRAGMA foreign_key_check" --json
```

Generate the schema and per-table count digests from both databases with the
same canonical, sorted SQL and compare them before deploying the new binding.
After the new binding round trip and signed health proof succeed, delete by the
exact old database ID. Re-read the Cloudflare database list and prove that ID is
absent. Do not run migration 0031 until the old ID is absent and every evidence
field below is recorded in the new database.

The capability assumptions above come from Cloudflare's documented strong R2
consistency and empty-bucket deletion rule, GitHub's documented one-hour
installation-token lifetime, and Cloudflare's supported D1 export/import path:

- <https://developers.cloudflare.com/r2/reference/consistency/>
- <https://developers.cloudflare.com/r2/buckets/delete-buckets/>
- <https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app>
- <https://developers.cloudflare.com/d1/best-practices/import-export-data/>

Record one JSON object in `project_lifecycle_rollout.remote_capability_evidence`.
It must have this shape; every timestamp is ISO 8601 and every value is public
operational evidence, never a secret:

```json
{
  "d1": {
    "oldDatabase": "thwip-staging-wnam",
    "newDatabase": "thwip-staging-wnam-v2",
    "oldDatabaseId": "old Cloudflare D1 database UUID",
    "newDatabaseId": "new Cloudflare D1 database UUID",
    "maintenanceEnabledAt": "2026-08-12T19:30:00.000Z",
    "exportCompletedAt": "2026-08-12T19:40:00.000Z",
    "importCompletedAt": "2026-08-12T19:50:00.000Z",
    "newDatabaseRoundTripAt": "2026-08-12T19:55:00.000Z",
    "newBindingActivatedAt": "2026-08-12T20:00:00.000Z",
    "oldDatabaseDeletedAt": "2026-08-12T20:05:00.000Z",
    "exportSha256": "64 lowercase hex characters",
    "schemaSha256": "64 lowercase hex characters",
    "rowCountSha256": "64 lowercase hex characters",
    "quickCheck": "ok",
    "foreignKeyViolations": 0
  },
  "r2": {
    "oldBucket": "thwip-evidence-staging",
    "newBucket": "thwip-evidence-staging-v2",
    "copyCompletedAt": "2026-08-12T20:00:00.000Z",
    "newBucketRoundTripAt": "2026-08-12T20:05:00.000Z",
    "oldBucketDeletedAt": "2026-08-12T20:10:00.000Z"
  },
  "github": {
    "oldKeyFingerprint": "old-key-fingerprint",
    "newKeyFingerprint": "new-key-fingerprint",
    "newKeyAcceptedAt": "2026-08-12T20:05:00.000Z",
    "oldKeyRejectedAt": "2026-08-12T20:10:00.000Z",
    "oldPrivateKeyDeletedAt": "2026-08-12T20:10:00.000Z",
    "oldInstallationTokensExpiredAt": "2026-08-12T21:10:00.000Z",
    "oldInstallationTokenRejectedAt": "2026-08-12T21:10:00.000Z"
  },
  "approvedBy": "operator identity",
  "changeUrl": "https://github.com/recallnet/thwip/issues/398"
}
```

Set `remote_capabilities_retired_at` to a time at or after the old installation
token rejection, in the same D1 statement. Keep
`destructive_schema_ready_at` null. The public health response must now show the
retirement timestamp and `remoteCapabilityEvidenceComplete: true`, while
`cleanupReady` remains false.

## Phase 2: finish the schema while traffic stays fenced

1. Run the migration command again. It must refuse unless the exact reviewed
   Worker is live and the capability evidence is present.
2. Apply `0031_finish_github_repository_lifecycle.sql`. This removes the legacy
   tombstone schema, makes project incarnation ownership mandatory, sets
   `destructive_schema_ready_at`, and deliberately leaves maintenance mode on.
3. Confirm `/health` and `/v1/schema` still work, every other route returns
   `503`, queue messages are delayed, scheduled work stops, and
   `projectLifecycle.cleanupReady` is true.
4. Run the migration command again. It must apply the contiguous
   `0032_private_agent_feedback_foundation.sql` and
   `0033_verifier_protocol_v3.sql` before-worker phase and nothing else.
5. Deploy the exact current canonical `main` Worker. Do not deploy an older SHA.
   Confirm signed `/health` reports that full build SHA, maintenance mode, and
   `schema.capabilities.privateAgentFeedback: true` plus
   `schema.capabilities.verifierProtocolV3: true`. It must also report a
   `workerDeploymentId` different from `verifierV3PredeployId`; this is the
   causal proof that this deploy happened after migration `0033`.
6. Run the migration command once more. It must select only
   `0034_reopen_after_project_lifecycle.sql`. The runner and SQL both refuse
   unless `0031`, `0032`, and `0033` are applied, complete cutover/backfill
   evidence remains, maintenance is active, and the exact compatible Worker is
   live. Only the final statement in `0034` clears maintenance mode.
7. Confirm `/health` reports `projectLifecycle.cleanupReady: true`,
   `schema.capabilities.lifecycleReopened: true`, and the exact expected build.
8. Run the bounded release drainer. Confirm pending releases remove all D1,
   Durable Object, and new- and legacy-prefix R2 state while preserving tenant
   billing, principals, and unrelated repositories.
9. Re-select one removed repository in the GitHub App. Confirm it returns as a
   fresh disabled project with no old policy, proof, queue, grant, metric, or
   evidence state.

There is no traffic window between `0031` and `0034`. The Worker-level
maintenance gate remains the fence after `0031` removes the imported table
triggers. Never clear `maintenance_mode` by hand and never run raw Wrangler to
skip a barrier.

Keep issue #398 open until Phase 2 and its live evidence are complete. The two
phases should use separate pull requests under the same issue; a separate
prerequisite issue is not needed because the cutover is part of this feature's
acceptance evidence.
