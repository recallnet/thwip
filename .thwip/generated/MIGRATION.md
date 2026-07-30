# Migrating recallnet/thwip off GitHub's merge queue

Generated from ruleset `19927569` as it stands today. Nothing here has been
applied. Read the diff before running anything.

## What changes

The existing `thwip` proof check is **preserved**, with its App source pin
intact. The generated policy adds `Thwip / Merge`, adds `deletion` and
`non_fast_forward` protection, and removes GitHub's `merge_queue` rule, because
the Thwip App performs the merge in managed mode.

```
addedRules:            pull_request, deletion, non_fast_forward
removedRules:          merge_queue
addedRequiredChecks:   Thwip / Merge
removedRequiredChecks: (none)
safe:                  false  -- because removing merge_queue is intentional here
```

`safe: false` is the generator refusing to hide that it drops a rule. Removing
`merge_queue` is the point of this migration; every other removal would be a bug.

## Prerequisites that need a human

1. **App permissions.** GitHub App `4419870` needs `Checks: write`,
   `Contents: write`, and `Commit statuses: write`. The statuses permission is
   only for GitHub's source-selection prerequisite — Thwip publishes Check Runs.
   Adding permissions raises a consent prompt on the `recallnet` installation
   that the owner has to accept.
2. **Source selection.** GitHub will not let a brand-new check context be
   source-pinned in one step, so step 4 below requires selecting the Thwip App as
   the expected source in the branch-protection UI.

## Order (plan.md §44.3). Do not skip step 5.

```bash
OWNER=recallnet REPO=thwip
API='-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"'

# 2. Disabled bootstrap policy: the context exists, unpinned, enforcing nothing.
gh api --method POST "/repos/$OWNER/$REPO/rulesets" \
  --input .thwip/generated/managed-policy-bootstrap.ruleset.json

# 3. Have the App publish one terminal `Thwip / Merge` check on the default
#    branch head, so GitHub can offer the App as that context's source.
#    external_id starts with `bootstrap:` and it is never read as a verdict.

# 4. Attach the App as the expected source while still disabled.
gh api --method PUT "/repos/$OWNER/$REPO/rulesets/<BOOTSTRAP_RULESET_ID>" \
  --input .thwip/generated/managed-policy-pinned-disabled.ruleset.json

# 5. Canary negative test, on a temporary target, with the real one still
#    disabled: prove an Actions check named `Thwip / Merge` CANNOT satisfy the
#    requirement and the App's check CAN. Without this, activation can require a
#    check whose source was never verified — which is how a branch becomes
#    permanently unmergeable.

# 6. Activate, then take ownership of the branch.
gh api --method PUT "/repos/$OWNER/$REPO/rulesets/<BOOTSTRAP_RULESET_ID>" \
  --input .thwip/generated/managed-policy.ruleset.json
gh api --method POST "/repos/$OWNER/$REPO/rulesets" \
  --input .thwip/generated/managed-ownership.ruleset.json

# 7. Remove the merge_queue rule from ruleset 19927569 only after a Thwip Queue
#    turn has merged a pull request in canary.
```

## Recommended: observe first

`activation_state = observe` publishes the same reasoning the queue would enforce
but always concludes `neutral`, so the queue can run beside the existing
`merge_queue` gate and show what it would have done before it can block anything.
That makes the whole migration reversible up to step 6.
