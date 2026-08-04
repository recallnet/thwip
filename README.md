# thwip

Git-native CI proofs for agent-run pipelines.

Run the approved CI pipeline locally, attach a signed proof to the
commit, and let the ruleset-protected thwip GitHub App verify it in seconds.
The merge queue on this repository merges any internal PR automatically
once its exact head commit carries a valid thwip proof.

The CLI ships on npm as `@recallnet/thwip`. Users install that; this repository
is the control plane and the packages behind it, and nobody needs to clone it to
use thwip.

- Product: https://recall.network
- Control plane (staging): https://thwip.recall.net
- Design: `plan.md`
- Historical deviations from the original v1 slice: `DEVIATIONS.md`

## Effective policy and first activation

Repositories inherit organization proof defaults from the dashboard. An
optional `thwip.yaml` on the active default branch overrides those defaults;
candidate pull-request YAML never governs or approves its own proof. A global
policy can activate immediately when a project is enabled. Without either
source the App reports the missing policy explicitly and fails closed.

Projects begin with the distinct `thwip / proof (observe)` App check. After a
recent PASS under the active policy, an administrator can enforce it, and the
App publishes `thwip` from then on.

On a queue-enrolled branch the required `thwip` context follows whoever
publishes it. A repository still observing has it sourced from GitHub Actions
and satisfied by the `thwip-required.yml` the setup pull request adds. Once an
administrator enforces the App's proof check, setup's last step moves the pin to
the App, and from then on one publisher satisfies it instead of any workflow in
the repository. `docs/adr/0001-app-native-proof-checks.md` has the order and why
it cannot run the other way round.

## Contributing (this repo eats its own dogfood)

```sh
git checkout -b my-change
# ...edit, commit...
pnpm build          # once
thwip run           # runs lint/typecheck/test, signs, amends HEAD
thwip ship          # pushes, opens the pull request, joins the queue
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
runs that build. A checkout that has not been built falls back to the release
and says so on stderr. Nothing in the resolver reaches the network. To undo the
lot, delete `~/.local/bin/thwip` and `~/.local/share/thwip`.

Pointing `thwip` straight at one worktree's `dist/main.js` is what this
replaced, and it cost a day: five worktrees ran the sixth one's build, so a bug
in `thwip ship` that reported a queued pull request which did not exist survived
every run of it.

`pnpm exec thwip` also runs this checkout's build, from any directory in it.

`thwip version` prints the version, the commit the build was made from, and the
file that is running. A build standing in a checkout it did not come from says
so on stderr before it does anything, which is the net under all of the above.

```sh
thwip version
```
