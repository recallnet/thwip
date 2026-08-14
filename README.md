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
- Reused CI measurements: [docs/reused-ci-metrics.md](docs/reused-ci-metrics.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

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

Inside this repository, use the CLI built by the checkout you are editing. This
prevents one worktree from running another worktree's code.

After `pnpm build`, install the resolver:

```sh
node scripts/install-thwip.mjs
```

It places `thwip` in `~/.local/bin` and selects the current checkout's
`packages/cli/dist` build. Pass `--write-path` if you want the installer to add
that directory to your shell configuration. The resolver does not reach the
network when it selects a checkout build.

Until the resolver is on your `PATH`, run the checkout directly with
`node packages/cli/dist/main.js`. Run `thwip version` to see the commit and file
that are executing.
