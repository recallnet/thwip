# thwip

Thwip is a merge queue for teams whose pull requests come from coding agents.
An agent runs the required suites where the code lives, the CLI signs a proof
of the exact Git tree those suites ran against, and a protected GitHub check
verifies that proof instead of running the suites again in the cloud. Thwip
Queue then merges the pull request on the strength of that verified proof.

This repository holds the hosted service, the CLI, the GitHub Action, and the
packages they share. The CLI ships on npm as `@recallnet/thwip` and is
mirrored to GitHub Packages.

- Product: https://thwip.ai
- CLI guide: [packages/cli/README.md](packages/cli/README.md)
- Queue setup: [docs/queue-onboarding.md](docs/queue-onboarding.md)
- Independent deployment: [docs/self-hosting.md](docs/self-hosting.md)
- Database baseline for independent deployments: [docs/d1-baseline.md](docs/d1-baseline.md)
- Reused CI measurements: [docs/reused-ci-metrics.md](docs/reused-ci-metrics.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

## GitHub Action

Queue setup adds the required workflows. The pull-request job calls one Action
step, which verifies the proof and joins the queue:

```yaml
permissions:
  contents: read
  id-token: write
  checks: write
  pull-requests: read

steps:
  - uses: recallnet/thwip@c9e23c740ffe7d7f30123e829787647443007f7b
```

The hosted service needs no inputs. An independent control plane sets the
`endpoint` input to its HTTPS origin. The optional `github-token` input
defaults to the job's GitHub token.

## Develop this repository

You need Node.js 22 or newer and pnpm. Install the locked dependencies, then
run the checks your change can affect:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:workers
```

[CONTRIBUTING.md](CONTRIBUTING.md) describes the pull request and proof
workflow.

## Use the CLI from this checkout

After `pnpm build`, run the CLI through the root package command:

```sh
pnpm -w thwip version
pnpm -w thwip --help
```

`pnpm -w thwip <command>` runs `packages/cli/dist/main.js` from this checkout,
even from a nested workspace directory. It installs nothing and leaves your
`PATH` alone. The `version` command prints the commit and file that are
executing.

## License

Apache-2.0. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
