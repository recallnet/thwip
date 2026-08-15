# thwip

Verified local CI.

Your test suites already run on your machine. thwip signs a proof of the exact
Git tree they ran against, attaches it to the commit, and a protected GitHub
check verifies that proof instead of running everything again in the cloud.

A check that takes seconds rather than minutes, and a signed record of what ran,
against which code, by whom.

## Install

```
npm install -g @recallnet/thwip
```

Node 22 or newer. To skip the global install, use `npx @recallnet/thwip`
wherever the commands below say `thwip`.

The public npm registry is the release authority. The package contains the
built CLI; a consuming repository never clones or builds this repository.

## Getting started

```
npx @recallnet/thwip@latest init
```

Init is the safe setup and refresh command for a first checkout or another
machine. It checks your session, key, GitHub origin, and live project state. It
then refreshes only bounded guidance in root `AGENTS.md` and `CLAUDE.md`. It
reports any human dashboard action still needed and never enrols a repository.

Repositories normally inherit organization defaults. To create an intentional
repository override, use `thwip init --required "lint,typecheck,test"` and
optionally `--profile PROFILE`.

`thwip ship --wait` is the full completion path. It runs the suites against the
committed tree, attaches the proof to `HEAD`, pushes, opens or updates the pull
request, joins the queue, and waits for the outcome. Use `thwip run` when you
only need to create or refresh a proof without shipping it.

A draft pull request still needs proof, but it must not enter the merge queue.
For a new draft, run `thwip run`, push the proved `HEAD`, then create it with
`gh pr create --draft`. For an existing draft, `thwip ship --no-queue` refreshes
and pushes its proof without joining the queue or marking the pull request
ready. Do not mark it ready or merge it until the user asks.

The CLI connects to `https://thwip.ai` by default. Set `THWIP_ENDPOINT` only
when an operator has given you a different control-plane origin.

Suite ids name the `package.json` scripts you already run. Configuration is one
committed file:

```yaml
version: 1
profile: fast
required:
  - lint
  - typecheck
  - test
```

## Commands

| Command | What it does |
| --- | --- |
| `thwip login` | Sign in through a device code that works over SSH |
| `thwip init` | Safely set up or refresh this machine and repository guidance |
| `thwip run` | Proof-only: run the required suites and sign a proof of the tree |
| `thwip verify` | Run the same checks the protected check will run |
| `thwip ship --wait` | Run, sign, push, open the pull request, and wait for the queue outcome |
| `thwip keys status` | Report which key signs, and whether GitHub lists it |
| `thwip doctor` | Check the whole chain, from your key to the App's grants |
| `thwip queue` | Inspect and administer the merge queue |

`thwip doctor` changes nothing and exits zero only when every check passed. A
check nobody could read fails on its own, so a report that says fine is a report
that looked. Reading App permissions needs repository admin; pass
`--allow-unread` when you are not one.

Run `thwip --help` for the full list.

## Signing keys

Proofs are signed with an SSH key that GitHub lists as a **signing key** for your
account. GitHub keeps signing keys and authentication keys in separate lists, and
only the first is read. `thwip keys status` tells you which key would sign and
whether GitHub knows about it.

Your private key is never read, moved, or transmitted.

## Learn more

https://thwip.ai

## License

Apache-2.0
