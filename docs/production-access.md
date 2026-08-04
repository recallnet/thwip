# Working on production without a key to the database

`thwip.recall.net` runs one Worker against one D1 database, and that database is
live. There is no staging copy to practise on. Everything below assumes that.

This page says how to deploy, how to diagnose, and how to change something,
under the smallest authority each of those needs. The short version: diagnosing
needs a login, deploying needs a token that can edit one Worker, and only
applying a migration needs a credential that can touch the database.

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

For whoever does hold a D1 credential, and only for reads the table above cannot
answer:

```
node scripts/d1.mjs "SELECT * FROM queue_attestations WHERE attempt_id = 'att_...' LIMIT 5"
```

It takes one statement, it has to open as `SELECT`, `WITH` or `EXPLAIN`, and it
refuses anything containing a word that changes the database. It prints the
wrangler command it is about to run before it runs it, so what was read is in
the transcript. It fails closed: a `SELECT` whose text happens to contain
`delete` is refused, and widening the quoting is the reader's problem rather
than the parser's.

`wrangler d1 execute` is no longer the documented way to look at production.
Reaching for it means the statement was not a read, and a statement that is not
a read belongs in the section below.

## Changing something

Every mutation goes through a route that writes a record naming who asked.

| Change | Call |
| --- | --- |
| Answer a chain finding | `POST /v1/queue/:repositoryId/heal` with `{ finding, code, reason }` |
| Record a merge the queue authorized | `POST /v1/queue/:repositoryId/repair` |
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

Without them it falls back to the interactive wrangler session, says so, and
names the token to create. The session works, and it carries the whole account.

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
- Zone / Workers Routes:Edit, scoped to `recall.net`

Give it **no D1 permission**. The database binding travels in `wrangler.jsonc`
as an id, and the id is not a secret. A deploy that fails asking for D1 is worth
reporting rather than working around, because it would mean deploy authority and
database administration cannot be separated on Cloudflare as configured.

## Applying a migration

```
pnpm --filter @thwip/control-plane run migrate:staging
```

This is the one command that administers the database, and it is deliberately
not part of a deploy. It needs its own token, holding **Account / D1:Edit** and
nothing else, exported the same way.

Each migration declares which side of the deploy it belongs on, in its header:

- `-- DEPLOY ORDER: before-worker` for a migration the next Worker reads. Apply,
  then deploy.
- `-- DEPLOY ORDER: after-worker` for a migration that needs the new Worker
  already live. Deploy, then apply.

The deploy gate refuses while a `before-worker` migration it needs is missing,
and names it. 0020 and 0021 sat unapplied under a Worker that read their tables
for four deploys, and every `/authorize` under `fresh` answered 500.

Migration 0023 is the irreversible end of the App-native Queue cutover. Follow
the deployment, repository proof, and rollback order in
[`queue-single-path-cutover.md`](queue-single-path-cutover.md) before applying it.

## When the live Worker predates `/v1/schema`

The gate refuses with a 404 and says to deploy once with
`THWIP_DEPLOY_ANYWAY=1`. That is the bootstrap, and it is needed exactly once.

## Rotation and revocation

Both tokens are revoked at **My Profile → API Tokens → Roll / Delete**. A
contributor leaving means deleting their deploy token; nothing else has to
change, because the deploy token is the whole of what they held. Roll both on
any suspicion, and after any laptop leaves the team.
