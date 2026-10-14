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

## Status and trust boundaries

This is an experimental reference implementation with first-party operational
use. Independent adoption, large-team reliability, saved developer time, and
avoided compute cost have not been established. A signature authenticates a
signer's claim; it does not prove that the machine executed the checks honestly
or that the code is correct. Protect signing keys, restrict enrolled signers,
and keep repository administration separate from merge authority.

The queue depends on GitHub, Cloudflare, active policy, and an available
verifier. Deployment operators must account for asynchronous merge recovery,
stale queue entries, CPU limits when verifying long signed chains, and an
exclusive handoff from any existing merge queue. See the
[onboarding guide](docs/queue-onboarding.md) and
[self-hosting guide](docs/self-hosting.md).

Proofs, logs, queue records, and dashboard responses can disclose repository
identifiers, commit metadata, signer identities, and check output. Review what
your suites emit before uploading evidence, and choose storage access and
retention rules for your deployment. Checked-in configuration names the
original hosted installation; it does not grant access or promise hosted
availability.

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

Use Node.js 24, as in the GitHub workflows, and pnpm 11.1.2, as declared in
`package.json`. Install the locked dependencies, then
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
