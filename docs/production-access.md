# Working on production without a key to the database

`thwip.ai` runs one Worker against one D1 database, and that database is
live. There is no staging copy to practise on. Everything below assumes that.

This page says how to deploy, diagnose, and change something under the smallest
authority each task needs. Most diagnosis needs only a Thwip login. Deployment
needs a token that cannot read D1. A rare direct database read gets a short-lived
read token. A migration gets a different short-lived edit token.

## Diagnosing, with no Cloudflare credential at all

A contributor who can sign in and read the repository can see everything the
queue knows. None of this reaches Cloudflare.

| Question | Call |
| --- | --- |
| What is the queue doing, and why is each entry stuck? | `GET /v1/queue/:repositoryId/explain?ref=refs/heads/main` |
| Which merge writes were started, and how did each settle? | the same call, `mergeOperations` |
| What does the queue believe right now, past the projection? | `GET /v1/queue/:repositoryId?ref=...&live=1` |
| Does the chain verify, and what would fix each finding? | `GET /v1/queue/:repositoryId/heal?ref=...` (repository admin) |
| The chain itself, record by record | `GET /v1/queue/:repositoryId/chain?ref=...` |
| One signed record by digest | `GET /v1/queue/records/:digest` |
| Can the App publish the check the branch requires? | `GET /v1/queue/:repositoryId/doctor` (repository admin) |
| Which migrations does the live database have? | `GET /v1/schema` (public) |
| What build is live? | `GET /health` (public) |
| Does the whole chain verify from outside? | `node scripts/verify-chain.mjs <owner/repo> <ref>` |

`verify-chain.mjs` needs no credential of any kind. Run `pnpm build` first; it
reads `packages/queue-protocol/dist`, and a session once read its
`MODULE_NOT_FOUND` as a clean result.

`mergeOperations` is the one that closed the last gap. The four merges that
landed unrecorded on 2 August were found by pulling merge operations out of
`queue_state.document` with a remote SQL statement, because nothing served them.
`/explain` serves them now, settled and unsettled, oldest first.

## Reading a row that has no route yet

Create a direct-read token only when the routes above cannot answer the question.
This is not an ordinary development credential. Link the request to a private
incident or maintenance record and get another operator's approval before
creating it.

1. Open **Cloudflare → My Profile → API Tokens → Create Token → Create Custom
   Token**.
2. Name it `thwip-d1-read-YYYYMMDD-HHMM`.
3. Give it only **Account → D1 → Read**, scoped to the Recall account.
4. Add an expiry within the next 24 hours. Restrict it to your current IP when
   practical.
5. Export it under the read-only name. Do not put it in
   `CLOUDFLARE_API_TOKEN`:

```sh
export THWIP_D1_ACCOUNT_ID=<recall-account-id>
export THWIP_D1_READ_API_TOKEN=<short-lived-token>
```

Then run the read with both the Cloudflare environment name and the live host:

```sh
node scripts/d1.mjs --env staging --confirm-live thwip.ai \
  "SELECT COUNT(*) AS count FROM queue_attestations"
```

It takes one statement, it has to open as `SELECT`, `WITH` or `EXPLAIN`, and it
refuses anything containing a word that changes the database. It prints the
database, live host and a SHA-256 digest of the statement. It does not echo SQL
literals, the token or result rows into diagnostic text. The query result still
appears in the current terminal. Treat it as live data and do not paste it into
an issue. A `SELECT` whose text happens to contain `delete` is refused; widening
the quoting is the reader's problem rather than the parser's.

Before the read, the script confirms that Cloudflare accepts the explicit token,
that it expires within 24 hours and that `SELECT 1` succeeds against the exact DB
binding in `wrangler.jsonc` without a write. Wrangler receives that token only.
It cannot fall back to `CLOUDFLARE_API_TOKEN`, an API key or the stored Wrangler
OAuth session.

Delete the token immediately after the read, then prove that it is gone:

```sh
node scripts/d1-identity.mjs verify-revoked --kind read
unset THWIP_D1_READ_API_TOKEN THWIP_D1_ACCOUNT_ID
node scripts/d1-identity.mjs verify-cleared --kind read
```

`verify-revoked` must say that Cloudflare rejects the token. If it says the token
is active or the result is uncertain, delete it in Cloudflare and repeat the
check. `verify-cleared` must say that no role-specific D1 credential remains in
the shell. It does not inspect an unrelated deploy token or Wrangler's stored
login. Record the UTC time, token name, statement digest, outcome and both
successful checks in the approving record. Do not copy the result rows there.

`wrangler d1 execute` is no longer the documented way to look at production.
Reaching for it means the statement was not a read, and a statement that is not
a read belongs in the section below.

## Changing application state

Every mutation goes through a route that writes a record naming who asked.
Schema migrations are the separate, reviewed operation described below.

| Change | Call |
| --- | --- |
| Answer a chain finding | `POST /v1/queue/:repositoryId/heal` with `{ finding, code, reason }` |
| Record a merge the queue authorized | `thwip queue repair --repo OWNER/NAME --merge-sha OID --reason TEXT [--attempt-id ID]` |
| Revoke a device key | `POST /v1/devices/:keyId/revoke` |
| Enrol an organization, project and policy | Install the GitHub App, then `POST /admin/sync` |
| Pause or resume a lane | `POST /v1/queue/:repositoryId/pause` \| `/resume` |

A heal binds the principal who asked as a witness on the transition, and the
digest of their reason sits inside the signed bytes. The reason text itself is
not stored, so keep it in the issue you opened about the finding.

SQL writes none of that. A repair carried out with a `wrangler d1 execute` is
invisible the day after, to the chain and to the next person, so it is not a
supported way to change anything here. Where a change has no route, the fix is
the route.

`queue repair` sends only the landed commit, the operator's reason, and an
optional attempt ID when more than one attempt authorized the same commit. The
service reads the commit from GitHub and rebuilds the record from its stored
signed merge intent. The landed commit's tree, ordered parents, generated title,
and message body must all match that intent. A verified local run also requires the stored signed
assignment and accepted receipt to agree with that intent. The command cannot
supply any of those claims. Its actor and reason are kept in a separate signed
`transition-repair-audit` attestation that names the repaired transition digest.

## Deploying

```
pnpm --filter @thwip/control-plane run deploy:staging
```

The gate builds first, refuses a checkout behind `origin/main`, refuses a
non-`main` branch, and asks `/v1/schema` whether the live database has the
migrations this code needs. That question used to be
`wrangler d1 migrations list --remote`, which meant shipping the Worker and
rewriting its tables were one authority and a contributor could not be handed
one without the other. It is an unauthenticated HTTP read now, so a deploy needs
no database permission.

Set these two and the deploy runs as a scoped token:

```
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

Without both variables, deployment refuses. It never falls back to the
interactive Wrangler session. Before deployment, the gate confirms that the
token is active and that Cloudflare returns a permission refusal when that token
tries the non-mutating live-D1 probe. A token that can query live D1 cannot
deploy.

### Automatic deploys from canonical main

`.github/workflows/deploy-staging.yml` verifies every landed `main` SHA against
the public signed merge chain. It reads the exact merge record rather than
looking for a developer proof or signature on the GitHub App-created merge
commit. Override merges and external movements do not deploy.

The workflow is safe to merge before its credential exists. Its evidence job
runs, but the deploy job stays skipped until a repository administrator sets
the repository variable `THWIP_STAGING_DEPLOY_ENABLED` to `true`. A manual run
is an evidence-only rehearsal by default; select its `deploy` input only for a
deliberate recovery deploy.

To enable the deploy job:

1. Create the `staging` GitHub environment.
2. Add the environment secret `CLOUDFLARE_API_TOKEN` with the permissions below
   and no D1 permission.
3. Add the environment variable `CLOUDFLARE_ACCOUNT_ID`.
4. Set the repository variable `THWIP_STAGING_DEPLOY_ENABLED` to `true`.

The workflow uses a read-only `GITHUB_TOKEN`. It installs from the lockfile,
verifies that its exact SHA is still canonical `main`, verifies the signed
non-override merge record, runs the existing build and predeploy schema gate,
stamps the full workflow SHA, publishes, and waits for `/health` to report that
same SHA. It never applies a migration.

### The token a deploy needs

Create it at **My Profile → API Tokens → Create Token → Create Custom Token**:

- Account / Workers Scripts:Edit
- Account / Workers R2 Storage:Edit
- Account / Workers KV Storage:Edit
- Account / Queues:Edit
- Account / Workers Tail:Read
- Account / Account Settings:Read
- User / User Details:Read
- User / Memberships:Read
- Zone / Workers Routes:Edit, scoped to `thwip.ai`

Give it **no D1 permission**. The database binding travels in `wrangler.jsonc`
as an id, and the id is not a secret. The gate tests the real boundary before
every deploy. A deploy that fails this check should be reported, not worked
around.

## Applying a migration

Create a new credential for one reviewed migration window. The approving record
must name the migration files, their reviewed commit, the operator and the
rollback owner. Do not put SQL, customer rows or credential values in it.

1. Open **Cloudflare → My Profile → API Tokens → Create Token → Create Custom
   Token**.
2. Name it `thwip-d1-migration-YYYYMMDD-HHMM`.
3. Give it only **Account → D1 → Edit**, scoped to the Recall account. Add no
   Worker, R2, KV, Queue, Zone, user or token-management permission.
4. Add an expiry within the next 24 hours. Restrict it to your current IP when
   practical.
5. Export it under the migration-only name:

```sh
export THWIP_D1_ACCOUNT_ID=<recall-account-id>
export THWIP_D1_MIGRATION_API_TOKEN=<short-lived-token>
```

Then run:

```sh
pnpm --filter @thwip/control-plane run migrate:staging -- \
  --confirm-live thwip.ai
```

This is the one command that administers the database, and it is deliberately
not part of a deploy. `staging` is the historical Cloudflare environment name;
the required `thwip.ai` confirmation states that this is the live database, not
a practice copy.

The command confirms that the explicit token is active, expires within 24 hours
and can run a non-mutating `SELECT 1` against the configured database. Cloudflare
does not let a token read its own full policy unless it also receives API-token
management access. That broader permission would defeat least privilege, so the
operator must confirm the D1-only policy in the creation screen. A read-only D1
token passes the safe probe but the migration itself fails before applying
anything; use D1 Edit for this command.

Wrangler creates a backup before applying a migration. Before starting, identify
the backup or Time Travel point that will be used if verification fails. After
the command, record the UTC start and finish time, migration filenames, reviewed
commit, result and token name in the approving record. Cloudflare Audit Logs
retain the API actor and token details; they do not replace this operation
record. Never paste query results or the token secret into it.

The command is a repository guard around Wrangler, not an alias for it. Wrangler
applies every pending migration it can see and has no phase selector. The guard
first reads the complete applied filenames from the live Worker, exposes only
the next contiguous phase through a temporary Wrangler configuration, and then:

- applies a pending set containing only `before-worker` migrations;
- applies a pending set containing only `after-worker` migrations only when the
  exact clean commit in the checkout is already live;
- leaves every later phase hidden until the next invocation reads the new live
  schema again.

The ordered release and barrier model lives in `@thwip/migration-plan`. The
migration command, deploy gate, `/health`, and `/v1/schema` all evaluate that
same model. A pending `before-worker` migration after an unapplied
`after-worker` barrier is reported as `blockedBehindBarrier`; it is not a blocker
for the preparatory Worker and it cannot be selected early. Do not infer a safe
order from the SQL comments or run Wrangler directly around the model.
The same model reports and hard-refuses any known migration recorded after an
earlier known migration is missing; a damaged ledger is never normalized into a
plausible phase.
Every non-empty migration phase also requires a clean checkout whose full HEAD
SHA equals freshly fetched `origin/main`; an operator cannot apply even an
additive batch from a stale or unmerged tree.

For the #398 in-place lifecycle migration, the supported order is exact:

1. Apply `0029` and `0030`.
2. Deploy the current canonical `main` Worker. Its v2 paths are compatible with
   schema through `0030`; do not deploy an older SHA.
3. Wait for the bounded project-ID backfill and the one-hour compatibility
   window reported by `/health`. No database, bucket, or GitHub App key is
   replaced.
4. Run the migration command to apply only `0031`. It enters maintenance,
   rebuilds the lifecycle tables in the existing D1 database, and leaves
   maintenance on.
5. Run it again to apply `0032` and `0033` while all traffic stays fenced.
6. Deploy the exact current canonical `main` Worker again. Confirm `/health`
   reports that build, maintenance mode, the `0032`/`0033` capabilities, and a
   new `workerDeploymentId`. Migration `0033` snapshots the deployment ID that
   served before its barrier; `0034` refuses until a different deployment ID is
   serving, even when canonical `main` still has the same commit SHA. Migration
   `0033` rejects the `unstamped` configuration before changing the v3 schema,
   so a correctly stamped deployment can repair and retry safely.
7. Run it once more to apply `0034`. Only `0034` reopens traffic.

Each invocation re-reads public schema and health first. `0031` refuses until
the lifecycle-aware Worker has served for one hour and the backfill is complete.
`0034` independently refuses unless the exact Worker build, all three preceding
migrations, complete backfill, and maintenance fence are present. A break-glass
deploy or direct migration is not part of this sequence.

Never work around a refusal with raw `wrangler d1 migrations apply`. For a mixed
tree, run the guarded command, deploy when the next phase is `after-worker`, then
run the guarded command again. Repeat until the current tree is level.
Historic filename collisions such as `0008` and `0023` are safe because the
guard, like D1, compares complete filenames rather than numeric prefixes.

Each migration declares which side of the deploy it belongs on, in its header:

- `-- DEPLOY ORDER: before-worker` for a migration the next Worker reads. Apply,
  then deploy.
- `-- DEPLOY ORDER: after-worker` for a migration that needs the new Worker
  already live. Deploy, then apply.

The deploy gate refuses while a `before-worker` migration it needs is missing,
and names it. 0020 and 0021 sat unapplied under a Worker that read their tables
for four deploys, and every `/authorize` under `fresh` answered 500.

As soon as the migration finishes, delete the token from Cloudflare while it is
still present in the shell. Then verify Cloudflare rejects it and clear the
shell:

```sh
node scripts/d1-identity.mjs verify-revoked --kind migration
unset THWIP_D1_MIGRATION_API_TOKEN THWIP_D1_ACCOUNT_ID
node scripts/d1-identity.mjs verify-cleared --kind migration
```

Do not log out the ordinary Wrangler session as part of this run. These commands
never used it. The two verification lines prove that the temporary role token is
revoked and no longer present in the shell. Add both successful checks to the
operation record, without the credential value.

## Deploying past the gate

The gate refuses for five separate reasons: a checkout behind main, a tree that
is not main, a missing `/v1/schema`, a schema answer it could not read, and
migrations the code needs. One variable used to excuse all five together, so
reaching for it to ship from a branch also waved through the schema checks
nobody was thinking about.

An exception now names the guard it excuses and says why:

```
THWIP_BREAK_GLASS="unmerged-tree: the queue cannot merge its own repair" pnpm deploy:staging
```

Every other guard still refuses. The guards that can be named are
`behind-main`, `unmerged-tree`, `schema-endpoint-missing`, `schema-unreadable`
and `pending-migrations`.

The reason is not paperwork. The deploy stamps the worker with it, `/health`
publishes it for as long as that worker is running, and the `queue clock`
watchdog fails every ten minutes while an exception is live. A deploy from main
clears it, so the alarm stops when the work has merged and shipped the ordinary
way, not when somebody remembers to silence it.

### When the queue cannot merge its own repair

This is the case the mechanism exists for. Deploying needs main, writing main
needs the queue, and a queue that is down cannot merge the fix that would revive
it. Break the deadlock with `unmerged-tree`, then merge and deploy from main as
soon as the queue is moving again.

### When the live Worker predates `/v1/schema`

The gate refuses with a 404. Deploy once with
`THWIP_BREAK_GLASS="schema-endpoint-missing: bootstrapping the endpoint the gate
reads"`, and the check works from then on.

## Rotation and revocation

The deploy token is revoked at **My Profile → API Tokens → Roll / Delete**. A
contributor leaving means deleting their deploy token. Roll it on any suspicion
and after any laptop leaves the team. Direct D1 read and migration tokens are
not rotated or kept: create one for a named operation, delete it immediately,
and run the revocation checks above.
