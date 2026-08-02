# The check that was never published, and where its sentences went

`Thwip / Merge` is deleted. Its wording is not: the part of it a developer
needed now reaches them on `thwip / turn`, which GitHub already requires and
which is already published on every pull request.

## Why not publish it

Publishing was the other honest answer, and it loses on three counts.

**It would be a fourth check saying what three already say.** The repository
publishes `thwip` (proof of the tree), `thwip / turn` (whose turn it is) and
`thwip / candidate` (the verdict on the integrated candidate). Hold `buildCheck`
against `turnCheckRun` case by case:

| `buildCheck` case | already on the pull request |
|---|---|
| Queue paused | `thwip / turn` halted |
| Merged by the queue | the merge itself, and `thwip / candidate` |
| Removed from the queue | the entry is terminal; no check is published, correctly |
| Integrating (Offered/Active/…) | `thwip / turn` holds |
| Queued, projected order | `thwip / turn` waiting, "behind N" |
| A blocking reason and what to do | **nothing published this** |

One row was not covered, and it is the only row that told a developer something
they could act on.

**It could not become required here.** The live ruleset on `recallnet/thwip`
pins `thwip` to Actions (15368) and `thwip / turn` to the App (4419870), and
this task may not change it. A published, unrequired fourth check is decoration.
Making it required would need another bootstrap step, another pinned context and
another chance to repeat the block-forever bug the bootstrap work just fixed.

**Two publishers for one App, on the same commit, on the same events.** The
`thwip / turn` publisher earned its reliability the hard way: it publishes only
what changed, from every path that writes queue state, and it was silently
missing from `queueFromPullRequest` for most pull requests. Adding a second
App-published check on the same events doubles the surface where a state-writing
path can be given no publisher. The fix for the last one was to have fewer
places that publish, not more.

## What moved

`thwip / turn` was answering one question and had the material to answer two.
Every entry in the snapshot carries `primaryReason`, derived by `readiness.ts`
from every current fact on every GitHub event, and the check published none of
it. A developer waiting on a review and one whose branch conflicted read the
same sentence.

Now:

- The **title** names the problem. "Waiting for review", "Conflict with the base
  branch", "No accepted proof on this commit", "Waiting for a machine". This is
  `titleFor`, carried over unchanged.
- The **summary** prints the sentence for the reason, looked up from
  `@thwip/vocabulary` with `nextActionFor(reason, "check")`. Never copied. That
  is the same table the CLI and the dashboard read, and `one-vocabulary.test.ts`
  goes on holding the three against each other.
- It stays **in progress**, whatever the reason. A required check that has failed
  goes on refusing the merge until something re-runs it, which is the bug that
  made the old fused check rotate the lane between pull requests that could not
  take it. Being blocked is a reason to say more, never a reason to go red. This
  is asserted over the whole `BLOCKING_REASONS` union.
- **Halted** distinguishes an administrator's pause from a branch that moved
  outside the queue. "An administrator paused it, or the branch moved outside the
  queue" made the reader go and find out which, and only one of the two waits
  itself out. The cause is read off the snapshot in `haltReasonOf`.
- The **caveat** survives: the order changes as reviews and checks change. The
  queue re-derives readiness on every event and a promised position would be a
  lie.

### Making the publish reliable

Two gaps, both the shape of the bug that left most pull requests with no turn
check at all.

`turnCheckUpdates` published on a change of turn. A pull request whose review
landed and whose branch then conflicted was waiting both times, so nothing
republished and the sentence about the review stayed on the commit. The reason
is now part of what counts as a change. The waiting count deliberately is not:
it moves whenever anyone joins or leaves, and publishing the whole queue for
that is one GitHub request per entry per command.

`publishTurnCheckFor` in `index.ts` skipped the write when status, conclusion
and title matched. `REVIEW_REQUIRED` and `CODEOWNER_REVIEW_REQUIRED` share a
title and differ in what to do about them, so the wrong instruction stayed on
the commit. It compares the summary too.

## What happened to `runTurn`

Deleted with `driver.ts`.

The turn the queue actually runs is `/authorize` with `prepare: true`, the PUT
made by `.github/workflows/thwip-merge.yml`, and `attestation.ts`, which builds
and signs the intent and the transition record and stores them. `runTurn` was a
second, complete implementation of that sequence with no production caller.
Every invariant fix therefore had to be made in two places, and one of them was
not: the driver built its merge commit message by hand and left off the
attribution trailer, so a merge it wrote would have been read back by the push
webhook as somebody pushing around the queue and appended a chain link for work
the queue itself did. That was caught in PR 122's neighbourhood by a test, never
by a user, because the code never ran.

`mergeCommitMessage` in `merge-commit.ts` is the one message. `mergePullRequest`
refuses an unattributed one, so a future merge path that forgets the trailer
cannot reach GitHub at all. Both guards are still tested.

## Also deleted

- `publishMergeCheck` in `github-port.ts`, uncalled.
- `THWIP_MERGE_CONTEXT` in `rulesets.ts`. The pin came out in 115; this is the
  constant. A comment in its place records what the name was for.

## Left standing, and named

`finalGuard`, `decideMergeWrite` and `classifyMergeResponse` in `turn.ts` lose
their last caller with `driver.ts`. They are not orphans of this change so much
as revealed by it: the production path guards through `store.classifyCallback`
and the reducer's invariants, binds the base and the tree in `mergePullRequest`,
and classifies the merge response inside `github-port.ts`, which has its own
copy of that logic at `mergeOnGitHub`. `turn.ts` still exports
`MergeAttemptOutcome`, which `github-port.ts` uses as the shared result type, so
the file stays. Removing the three functions and folding the duplicate
classification into one place is a change to `turn.ts` and `github-port.ts`,
files this task did not hold. It should be the next one.

## Verification

Baseline on `main`: 120 files, 1794 tests, green.
After: 118 files, 1766 tests, green. `pnpm typecheck` clean, `node
scripts/lint.mjs` reports `lint: ok`.

The new tests were red first: 14 failing in `turn-check.test.ts` against the
unchanged `turn-check.ts`, committed in that state as `194c32e`.

The count falls because `check.test.ts` (26) and `driver.test.ts` (16) go and 18
arrive. Nothing they asserted is unasserted now: the vocabulary drift guard, the
"every reason has a sentence" guard and the "an unknown code is quoted, not
invented" guard all moved to `turn-check.test.ts` and to the surviving
`one-vocabulary.test.ts` and `readiness.test.ts`, which now import `nextAction`
from `turn-check.ts`. The driver's attribution test is replaced by the two that
already covered the shipping path: `merge-commit.test.ts` and the
`mergePullRequest` refusal in `merge-attribution.test.ts`.
