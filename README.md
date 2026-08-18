# thwip

Thwip is a merge queue built for teams adopting agent workflows. It asks agents
to prove their work before it enters the queue and avoids repeating CI in the
cloud when the configured evidence is enough.

The CLI runs approved checks, signs evidence for the exact Git tree, and
attaches that evidence to the commit. The ruleset-protected GitHub App verifies
it and moves eligible pull requests through the queue.

The CLI ships on npm as `@recallnet/thwip`. Users install that package; this
repository contains the service, CLI, GitHub Action, and shared packages behind
it.

- Product: https://thwip.ai
- CLI guide: [packages/cli/README.md](packages/cli/README.md)
- Queue setup: [docs/queue-onboarding.md](docs/queue-onboarding.md)
- D1 self-hosting baseline: [docs/d1-baseline.md](docs/d1-baseline.md)
- Reused CI measurements: [docs/reused-ci-metrics.md](docs/reused-ci-metrics.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

Most teams should use the managed service at [thwip.ai](https://thwip.ai).
For teams that need independent operation, the source retains a manual
[control-plane setup path](docs/self-hosting.md); it does not require Stripe.

## GitHub Action

Queue setup adds the required workflows. The normal pull-request job calls one
Action step; the Action verifies the proof and joins the queue:

```yaml
permissions:
  contents: read
  id-token: write
  checks: write
  pull-requests: read

steps:
  - uses: recallnet/thwip@c9e23c740ffe7d7f30123e829787647443007f7b
```

The hosted service needs no inputs. A self-hosted control plane can set the
`endpoint` input to its HTTPS origin. The optional `github-token` input defaults
to the job's GitHub token.

## Develop this repository

Use Node.js 22 or newer and pnpm. Install the locked dependencies, then run the
checks relevant to your change:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:workers
```

You only need to run checks your change can affect. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the pull request and proof workflow.

## Use the CLI from this checkout

After `pnpm build`, run the CLI through the root package command:

```sh
pnpm -w thwip version
pnpm -w thwip --help
```

`pnpm -w thwip <command>` always runs `packages/cli/dist/main.js` from this
checkout, even from a nested workspace directory. It does not install anything
or change your `PATH`. The `version`
command shows the commit and file that are executing.
