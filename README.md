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
- Deviations from the plan taken for the v1 vertical slice: `DEVIATIONS.md`

## Effective policy and first activation

Repositories inherit organization proof defaults from the dashboard. An
optional `thwip.yaml` on the active default branch overrides those defaults;
candidate pull-request YAML never governs or approves its own proof. A global
policy can activate immediately when a project is enabled. Without either
source the App reports the missing policy explicitly and fails closed.

Projects begin with the distinct `thwip / proof (observe)` App check. After a
recent PASS under the active policy, an administrator can enforce the
App-owned `thwip` check and pin that expected App in the repository ruleset
before removing the previous verifier workflow.

## Contributing (this repo eats its own dogfood)

```sh
git checkout -b my-change
# ...edit, commit...
pnpm build          # once
thwip run                            # runs lint/typecheck/test, signs, amends HEAD
git push -u origin my-change
gh pr create --fill  # auto-merges via merge queue once the thwip check is green
```
