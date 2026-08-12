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

The public npm registry is the release authority. GitHub Packages carries the
same version for Recall development environments that route the whole
`@recallnet` scope there. Both packages contain the built CLI; a consuming
repository never clones or builds this repository.

## Getting started

```
thwip login                                    # sign in with GitHub
thwip init --required "lint,typecheck,test"    # write thwip.yaml
thwip ship --wait                              # run, sign, push, and wait for merge
```

`thwip ship --wait` is the full completion path. It runs the suites against the
committed tree, attaches the proof to `HEAD`, pushes, opens or updates the pull
request, joins the queue, and waits for the outcome. Use `thwip run` when you
only need to create or refresh a proof without shipping it.

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
| `thwip init` | Write `thwip.yaml` from the suites you name |
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
