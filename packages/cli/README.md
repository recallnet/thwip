# thwip

Verified local CI.

Your test suites already run on your machine. thwip signs a proof of the exact
Git tree they ran against and attaches it to the commit. A protected GitHub
check verifies that proof instead of running everything again in the cloud, so
the check finishes in seconds and leaves a signed record of what ran against
which code.

## Install

```
npm install -g @recallnet/thwip
```

You need Node 22 or newer. To skip the global install, use `npx @recallnet/thwip`
wherever the commands below say `thwip`.

The public npm registry is the release authority. The same release is mirrored
to GitHub Packages for environments that map the `@recallnet` scope there. The
package contains the built CLI; a consuming repository never clones or builds
this repository.

## Getting started

```
npx @recallnet/thwip@latest init
```

Run `init` on a first checkout or a new machine. It checks your session, key,
GitHub origin, and live project state, then refreshes the bounded guidance
section in the root `AGENTS.md` and `CLAUDE.md`. It reports any dashboard action
a person still has to take. It never enrols a repository.

Repositories inherit organization defaults. To set a deliberate repository
override, run `thwip init --required "lint,typecheck,test"`, with `--profile
PROFILE` if you need one.

`thwip ship --wait` is the full completion path. It runs the suites against the
committed tree, attaches the proof to `HEAD`, pushes, opens or updates the pull
request, joins the queue, and waits for the outcome. Use `thwip run` when you
only need to create or refresh a proof.

A draft pull request still needs proof but must stay out of the merge queue.
`thwip ship --draft` proves and pushes the exact `HEAD`, creates or refreshes
the draft pull request, and stops there. Leave it as a draft until the user
asks otherwise.

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
| `thwip init` | Set up or refresh this machine and repository guidance |
| `thwip run` | Run the required suites and sign a proof of the tree |
| `thwip verify` | Run the same checks the protected check will run |
| `thwip ship --wait` | Run, sign, push, open the pull request, and wait for the queue outcome |
| `thwip keys status` | Report which key signs, and whether GitHub lists it |
| `thwip doctor` | Check the whole chain, from your key to the App's grants |
| `thwip queue` | Inspect and administer the merge queue |

`thwip doctor` changes nothing and exits zero only when every check passed. A
check nobody could read counts as a failure. Reading App permissions needs
repository admin; pass `--allow-unread` when you are not one.

Run `thwip --help` for the full list.

## Signing keys

Proofs are signed with an SSH key that GitHub lists as a **signing key** for your
account. GitHub keeps signing keys and authentication keys in separate lists, and
thwip reads only the first. `thwip keys status` tells you which key would sign
and whether GitHub knows about it.

thwip never reads, moves, or transmits your private key.

## Learn more

https://thwip.ai

## License

Apache-2.0
