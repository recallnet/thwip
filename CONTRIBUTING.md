# Contributing to Thwip

Thank you for helping improve Thwip.

## Before you start

Search the existing issues and pull requests first. You do not need to open an
issue before a pull request. Small fixes and draft pull requests are welcome.
For a large change, an issue can help everyone agree on the problem before you
spend time on it.

You do not need to sign a contributor license agreement (CLA).

Do not use a public issue or pull request to report a vulnerability. Follow
[SECURITY.md](SECURITY.md) instead.

## Make a change

1. Fork the repository if you do not have write access.
2. Create a short-lived branch from the latest `main`.
3. Keep the change focused. Add or update tests when behavior changes.
4. Run the checks that are relevant to your change.
5. Open a pull request. Explain the problem, the solution, and how you tested
   it. Link the related issue when there is one.
6. Address review comments and resolve conversations only after the concern is
   handled.

The repository uses pnpm and the Node.js version used by its GitHub workflows.
Install dependencies with:

```sh
pnpm install --frozen-lockfile
```

The main checks are:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:workers
```

You do not need to run checks that cannot be affected by your change. The
protected queue may run more checks before merge.

## Proof and merge queue

This repository uses Thwip's signed proof and protected merge queue. If your
Thwip identity is active for this repository, build the workspace, commit the
change, and run:

```sh
thwip ship --wait
```

This runs the configured suites, signs proof for the exact commit, pushes the
branch, opens the pull request, and lets Thwip handle the queue.

If you cannot use Thwip for this repository, open a normal pull request. A
maintainer can explain the proof step and sponsor the pull request in the queue.
Do not forge, copy, or reuse proof from another commit or repository.

Public contributions from people without trusted write access need one
independent human approval. The pull request author cannot provide it, and new
commits require another look. Trusted contributors and maintainers may use the
fast path described in [.github/HUMAN_REVIEW.md](.github/HUMAN_REVIEW.md).

## Conduct

Be direct, respectful, and patient. Discuss the work, not the person. Do not
harass people, publish their private information, or submit spam. Maintainers
may edit or remove harmful content and may limit participation when needed to
keep the project safe and useful.

By contributing, you agree that your contribution is licensed under this
repository's Apache License 2.0.
