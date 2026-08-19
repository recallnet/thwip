# Independent control-plane setup

Most teams should use the hosted service at [thwip.ai](https://thwip.ai). It
includes managed upgrades and operations. The source also leaves independent
deployment possible for teams that need it. This is a manual setup path, not a
separate self-hosted product or support promise.

## What you provide

Use your own Cloudflare account, GitHub App and public HTTPS origin. The Worker
needs these Cloudflare resources:

- one D1 database;
- one R2 bucket;
- one Queue and one dead-letter Queue;
- the `BranchQueue` Durable Object declared in the example configuration;
- Worker static assets and the two scheduled triggers in that configuration.

Use a Workers Paid account. Signed queue work needs the 30-second CPU budget
declared in the example configuration. Wrangler should refuse the deployment if
the account cannot provide that budget; the Workers Free 10 ms CPU limit is not
enough.

Copy `wrangler.self-host.example.jsonc` to the ignored local file
`wrangler.self-host.jsonc`. Replace the
example resource names, all-zero D1 ID, `example.com` origin, and `replace-me`
GitHub values. Keep `migrations_dir` set to `migrations-baseline`. Do not point
a new database at the hosted `migrations` directory. The two migration tracks
are explained in [d1-baseline.md](d1-baseline.md).

```sh
cp wrangler.self-host.example.jsonc wrangler.self-host.jsonc
```

## GitHub App

Create a GitHub App owned by the account or organization that will run this
deployment. Use:

- callback URL: `<PUBLIC_ORIGIN>/api/auth/callback/github`;
- webhook URL: `<PUBLIC_ORIGIN>/api/github/webhooks`;
- setup URL: `<PUBLIC_ORIGIN>/dashboard`;
- the permissions and events listed in [queue-onboarding.md](queue-onboarding.md).

Put the App ID, slug and client ID in the local Wrangler configuration. Store
the client secret, private key and webhook secret as Worker secrets named:

- `GITHUB_APP_CLIENT_SECRET`;
- `GITHUB_APP_PRIVATE_KEY`;
- `GITHUB_WEBHOOK_SECRET`.

Also set `BETTER_AUTH_SECRET`, `THWIP_ADMIN_TOKEN`, and an ES256 private JWK in
`THWIP_SERVICE_SIGNING_PRIVATE_JWK`. Generate new values for this deployment;
never copy them from another Thwip instance. `GITHUB_SYNC_TOKEN` is optional and
only improves GitHub signing-key reads when no installation token is available.

Use the pinned Wrangler from this checkout when creating resources, applying
secrets, migrating, or deploying:

```sh
pnpm --filter @thwip/control-plane exec wrangler --help
```

The exact `wrangler d1 create`, `r2 bucket create`, `queues create`, and
`secret put` arguments depend on the names chosen in the local configuration.
Wrangler prints the D1 ID that must replace the all-zero example ID.

## Initialize and deploy

Install and build the clean checkout, then apply the baseline once to the empty
database named in the local configuration:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @thwip/control-plane exec wrangler d1 migrations apply \
  thwip-self-hosted --remote --config ../../wrangler.self-host.jsonc
```

Stamp the build and a new deployment generation, then deploy:

```sh
export BUILD_SHA="$(git rev-parse HEAD)"
export DEPLOYMENT_ID="$(node -e 'console.log(crypto.randomUUID())')"
pnpm --filter @thwip/control-plane exec wrangler deploy \
  --config ../../wrangler.self-host.jsonc \
  --var "BUILD_SHA:$BUILD_SHA" \
  --var "DEPLOYMENT_ID:$DEPLOYMENT_ID"
```

Confirm that `<PUBLIC_ORIGIN>/health` reports the same build SHA, deployment ID,
and `billing.mode` as `disabled`. `<PUBLIC_ORIGIN>/v1/schema` should report the
baseline track with no blockers. Install the GitHub App on a test repository,
run setup, and require the doctor check to pass before protecting a branch.

## Billing

The example sets `BILLING_MODE` to `disabled`. Stripe is not required, billing
controls are hidden, and organizations use the existing pro limits. The hosted
service sets `BILLING_MODE` to `stripe` and supplies its own Stripe secrets and
price IDs. A partial Stripe configuration is refused.

## Upgrades and recovery

Future shared migrations start at `1001`. Apply them from the baseline
migration directory before or after the Worker as their declared release phase
requires. Never apply `1000` to an existing hosted database or copy migration
ledger rows between tracks.

Back up D1 with Wrangler's export command and retain a copy of the R2 evidence
bucket under the storage policy you choose. Restore the database with its own
ledger, run the foreign-key check, and run SQLite's integrity check against a
local exported copy before returning the Worker to service. See
[d1-baseline.md](d1-baseline.md) for the track rules.

## Public repository boundary

The hosted `wrangler.jsonc`, `.github/workflows/deploy-staging.yml`,
`docs/production-access.md`, and `docs/blog-ops.md` describe Recall-operated
infrastructure. They are not part of an independent deployment. A clean public
root should use the example configuration and this document instead.
