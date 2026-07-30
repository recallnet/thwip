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

## Getting started

```
thwip login                                    # sign in with GitHub
thwip init --required "lint,typecheck,test"    # write thwip.yaml
thwip run                                      # run the suites and sign a proof
```

`thwip run` executes the suites against the committed tree and attaches the proof
to `HEAD` as a Git trailer. Push, open a pull request, and the check reads it.

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
| `thwip run` | Run the required suites and sign a proof of the tree |
| `thwip verify` | Run the same checks the protected check will run |
| `thwip ship` | Run, sign, push, open the pull request, take a queue turn |
| `thwip keys status` | Report which key signs, and whether GitHub lists it |
| `thwip queue` | Inspect and administer the merge queue |

Run `thwip --help` for the full list.

## Signing keys

Proofs are signed with an SSH key that GitHub lists as a **signing key** for your
account. GitHub keeps signing keys and authentication keys in separate lists, and
only the first is read. `thwip keys status` tells you which key would sign and
whether GitHub knows about it.

Your private key is never read, moved, or transmitted.

## Learn more

https://recall.network

## License

Apache-2.0
