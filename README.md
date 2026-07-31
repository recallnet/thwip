# thwip

Git-native CI proofs for agent-run pipelines.

Run the approved CI pipeline locally, attach a signed proof to the
commit, and let a ruleset-protected GitHub check verify it in seconds.
The merge queue on this repository merges any internal PR automatically
once its exact head commit carries a valid thwip proof.

The CLI ships on npm as `@recallnet/thwip`. Users install that; this repository
is the control plane and the packages behind it, and nobody needs to clone it to
use thwip.

- Product: https://recall.network
- Control plane (staging): https://thwip.recall.net
- Design: `plan.md`
- Deviations from the plan taken for the v1 vertical slice: `DEVIATIONS.md`

## First policy activation

An enabled repository with no active policy reports `BOOTSTRAP_PENDING` as a
successful, explicit onboarding check. That result does not approve the
candidate policy or its proof; it only avoids deadlocking the native merge
queue before a policy exists. After the onboarding pull request lands, the
control plane derives the policy from the exact current default-branch tree,
stores its canonical bundle and digest, and activates it. Later policy changes
remain governed by the existing active policy until their protected merge
lands.

## Contributing (this repo eats its own dogfood)

```sh
git checkout -b my-change
# ...edit, commit...
pnpm build          # once
thwip run                            # runs lint/typecheck/test, signs, amends HEAD
git push -u origin my-change
gh pr create --fill  # auto-merges via merge queue once the thwip check is green
```
