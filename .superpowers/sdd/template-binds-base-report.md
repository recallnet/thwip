# The template binds the base too

## What was still broken

PR 123 taught `.github/workflows/thwip-merge.yml` to compose the merge commit on
the base the queue pinned and land it with a ref update that does not force. It
taught only this repository. `bootstrap-workflows.ts` emits the workflow every
adopted repository runs, and that copy still called
`repos/$GITHUB_REPOSITORY/pulls/$PR/merge`: an expected head, no expected base,
a merge onto whatever the branch happened to be. Every enrolled repository
carried the defect that put four unattestable merges on `main`.

The empirical work is in `merge-binds-base-report.md` and was not repeated. The
trailer survives, the pull request closes as merged, and a required-status-checks
ruleset refuses the ref update while the check is absent.

## One merge

There were two, and they drifted twice: the attribution trailer went missing
from one of them, and the base binding reached only one of them. So the shell in
`bootstrap-workflows.ts` is the merge, and `.github/workflows/thwip-merge.yml`
is what it renders at `https://thwip.recall.net`.

- `scripts/generate-workflows.mjs` writes the checked-in file.
- `scripts/lint.mjs` fails when the file is not what the template renders.
- `bootstrap-workflows.test.ts` asserts the same thing, byte for byte, and the
  two drift tests that compared triggers and the concurrency group are gone:
  they compared everything except the part that was wrong.

The only difference between the old checked-in file and the new render is the
squash arm below. Everything else round-tripped unchanged.

## `landMergeOnPinnedBase`

Deleted, along with `mergePullRequest`.

TypeScript cannot generate the shell, so it could never have been the definition
both copies came from. It was a third spelling of a merge nothing called, and a
third spelling is exactly how the first two came to disagree. `mergePullRequest`
went with it: it is the base-unbinding call the new lint now refuses in any
workflow, uncalled, and keeping it while deleting the safe one would leave the
loaded half.

The attribution guard moved rather than went. It used to refuse an unattributed
message in front of a path that could not forget, because nothing called it.
`merge-attribution.test.ts` now runs the workflow's own `printf` under bash and
reads the trailer out of what it produces, so the guard sits on the path that
actually writes commits.

## Squash

Unchanged in substance and now shared. A squash commit has one parent, does not
contain the pull request head, so required checks refuse the ref update and
GitHub cannot detect the merge. The workflow refuses it by name.

Two things are new. The refusal posts to `/not-merged` with
`SQUASH_UNBINDABLE <method>`, so the lane frees immediately instead of being held
until its deadline while every pull request behind it waits on a merge nobody is
going to make. And `setupPullRequestBody` says it in the setup pull request: the
merge is a merge commit, a squash cannot be bound, set the queue to merge commits
before enabling it. An adopted repository configured for squash is told, rather
than discovering it one wedged lane at a time.

## The lint that missed this

`scripts/workflow-lint.mjs` holds structural rules about workflows and read only
`.github/workflows`. The template is TypeScript that emits YAML, so lint never
saw it, which is why the fix shipped to one copy.

Two changes. `checkMergeBindsBase` is a new rule:

- the merge-pull-request API is refused outright, in any workflow;
- a workflow that moves a branch ref must say `force:false`, never `force:true`,
  and never leave it to the default;
- and the commit it moves the ref to must be composed from `merge.baseSha`,
  `merge.treeOid` and `merge.parentShas` out of the authorize answer, because a
  base a run read for itself is not the base the signed record binds.

And `scripts/lint.mjs` now renders `setupPullRequestFiles` and runs every rule
over what it emits, reported as `bootstrap-workflows.ts -> <path>`.
`bootstrap-workflows.test.ts` runs the same rules on the same output, so the
template fails in the suite as well as at the gate.

## Verification

`pnpm vitest run`: 118 files, 1771 tests at the branch point, 1770 after. The
new tests fail before and pass after; the ten tests covering the two deleted
functions went with them. `pnpm typecheck` and `node scripts/lint.mjs` both
clean.

## Not addressed

The concurrency group still holds every lane in a repository, which is what PR
123 said. `managedOwnershipRuleset` still gives the App a pull-request bypass
over an `update` rule, which a direct ref update is not, so a repository
provisioned on the managed backend would refuse this merge. Nothing runs on that
backend.
