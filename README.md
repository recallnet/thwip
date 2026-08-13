# thwip

Git-native CI proofs for agent-run pipelines.

Run the approved CI pipeline locally, attach a signed proof to the
commit, and let the ruleset-protected thwip GitHub App verify it in seconds.
The merge queue on this repository merges any internal PR automatically
once its exact head commit carries a valid thwip proof.

The CLI ships on npm as `@recallnet/thwip`. Users install that; this repository
is the control plane and the packages behind it, and nobody needs to clone it to
use thwip.

- Product: https://thwip.ai
- Control plane (staging): https://thwip.ai
- Current Queue architecture: `docs/adr/0001-app-native-proof-checks.md`
- Queue onboarding and steady state: `docs/queue-onboarding.md`
- Reused CI measurement definitions: `docs/reused-ci-metrics.md`

## Effective policy and first activation

Repositories inherit organization proof defaults from the dashboard. An
optional `thwip.yaml` on the active default branch overrides those defaults;
candidate pull-request YAML never governs or approves its own proof. A global
policy can activate immediately when a project is enabled. Without either
source the App reports the missing policy explicitly and fails closed.

Repositories with namespaces that Git can merge cleanly but the application
must serialize can opt those paths into combined-candidate verification:

```yaml
version: 4
profile: fast
required: [lint, typecheck, test]
policy:
  exclusive_paths:
    - "migrations/**"
```

`*` and `?` match within one path segment. A whole `**` segment crosses
directories. Patterns are rooted at the repository. A fast-profile pull request
that adds, changes, deletes, renames, or changes the mode of a matching path must
pass the pinned candidate verifier against its combined tree before it merges.
The queue processes one candidate at a time, so the next matching pull request
is rebuilt and checked on the base that includes the first. If GitHub cannot
return both complete trees, the queue fails closed. With no `exclusive_paths`,
the queue behaves as before.

Projects begin with the distinct `thwip / proof (observe)` App check. After a
recent PASS under the active policy, an administrator can enforce it, and the
App publishes `thwip` from then on.

The setup workflow and App never publish the same check name. During the staged
handoff the Actions-owned proof gate is `thwip / workflow`, satisfied by the
`thwip-required.yml` the setup pull request adds. Once an administrator enforces
the App's proof check, setup replaces that requirement with the App-owned
`thwip` context. `docs/adr/0001-app-native-proof-checks.md` has the order and why
it cannot run the other way round.

## Contributing (this repo eats its own dogfood)

```sh
git checkout -b my-change
# ...edit, commit...
pnpm build          # once
thwip ship --wait   # runs, signs, pushes, opens the pull request, and waits for merge
```

### Which thwip are you running

Inside a checkout, `thwip` runs that checkout's build from `packages/cli/dist`.
Outside one, it runs the published release. So a person editing CLI code runs
the code they edited, in whichever worktree they are standing in, and nobody has
to re-point anything after a build.

`scripts/thwip-resolver.sh` decides that, and it has to be the `thwip` on your
PATH for any of it to hold. The installer puts it there:

```sh
node scripts/install-thwip.mjs              # add --write-path to edit your shell rc
```

It writes `~/.local/bin/thwip`, fetches the published release into
`~/.local/share/thwip/release`, tells you the one line to add if
`~/.local/bin` is not on your PATH, and then runs `command -v thwip`,
`thwip --version` and `thwip keys status` before it says it worked. Run it
again any time; it changes nothing that is already right.

The resolver walks up for a checkout whose `packages/cli` is this project and
runs that build. A checkout that has not been built stops with the exact build
command instead of running code from somewhere else. Nothing in the resolver
reaches the network. To undo the lot, delete `~/.local/bin/thwip` and
`~/.local/share/thwip`.

Pointing `thwip` straight at one worktree's `dist/main.js` is what this
replaced, and it cost a day: five worktrees ran the sixth one's build, so a bug
in `thwip ship` that reported a queued pull request which did not exist survived
every run of it.

`pnpm exec thwip` also runs this checkout's build, from any directory in it.

`thwip version` prints the version, the commit the build was made from, and the
file that is running. A build standing in a checkout it did not come from stops
before it does anything and prints the exact resolver repair.

```sh
thwip version
```

### Proof warning before push

GitHub remains the proof authority, but a missing proof is cheaper to catch
before a remote check fails. This installs one non-blocking `pre-push` warning
in the repository's shared Git directory, so it covers every linked worktree:

```sh
thwip setup --install-push-warning
```

The hook checks the exact outgoing branch commit, names the current checkout
and remediation, and always allows the push. For an intentional low-level push,
set `THWIP_ALLOW_UNPROVEN_PUSH=1`. Thwip refuses to overwrite an existing hook
that it does not manage; remove the marked Thwip hook to uninstall it. The
repository setup prompt offers this command and runs it only after approval.
