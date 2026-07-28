# thwip

Git-native CI receipts for agent-run pipelines.

Run the approved CI pipeline locally, attach a signed receipt to the
commit, and let a ruleset-protected GitHub check verify it in seconds.
The merge queue on this repository merges any internal PR automatically
once its exact head commit carries a valid thwip receipt.

- Control plane (staging): https://thwip.recall.net
- Design: `plan.md`
- Deviations from the plan taken for the v1 vertical slice: `DEVIATIONS.md`

## Contributing (this repo eats its own dogfood)

```sh
git checkout -b my-change
# ...edit, commit...
pnpm build          # once
node packages/cli/dist/main.js run   # runs lint/typecheck/test, signs, amends HEAD
git push -u origin my-change
gh pr create --fill  # auto-merges via merge queue once the thwip check is green
```
