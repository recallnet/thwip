# Receipt walks to merge

An accepted receipt now reaches a merge and a signed `verified-merge` record.
`recallnet/thwip-test` pull request 3 merged under `fresh` and the chain for
`refs/heads/main` holds one link, sequence 1.

## Which of the two it was: neither

The question was whether a device-only lane never reaches `walkToMergeReady`, or
reaches it too rarely for the execution deadline. It is neither. The lane is
driven at the moment the receipt is accepted, and by the sweep after that, and
both were already true before this work started.

The premise the question rests on is wrong. `att_3c3007bb` did not run on
`6f35b5ab4bff`. That merge commit was authored `2026-08-03T03:15:07Z` and the
Worker holding it was deployed at `03:16:47Z`; the attempt was offered at
`02:40:11Z` and reaped at `03:00:53Z`. The deployment before it went out at
`2026-08-02T23:35:43Z`. So the previous fix had never run in production when the
failure it was supposed to explain was recorded, and no conclusion about it could
be drawn from that attempt.

What the attempt actually shows, from `recallnet/thwip-test` runs:

```
02:40:34  receipt accepted
02:40:38  thwip-merge dispatched          run 30779871965
02:40:45  authorize: RULESET_DRIFT
02:49:14  the branch ruleset was edited
02:50:36  the developer pushed; the entry followed, the attempt did not
02:50:41  authorize: INTEGRATION_RECEIPT_TREE_MISMATCH
02:57:07  authorize: INTEGRATION_RECEIPT_TREE_MISMATCH
03:00:53  EXPIRED_EXECUTION
```

Four seconds from the receipt to the dispatch. The deadline is twenty minutes and
the sweep is five, so the timing had room four times over. Every refusal came
from the gate, and each named a different cause.

Reproduced live on the current code, the same shape held: receipt accepted
`03:51:30`, `thwip-merge` dispatched `03:51:36`, refused. Driving was never the
problem.

## What was actually stopping it

Three things, found by running the deployed system rather than the suite.

**A base that moved outside the queue broke its chain.** Somebody pushing
straight to `main` made the reducer push a link carrying `external:<sha>` where a
record digest belongs. Nothing signs that link, so no reader can fetch it, and the
queue names its chain head as `previousTransitionDigest` in everything it signs
after: the assignment a device is handed, and the merge intent behind a merge.
Both are validated before signing against a protocol that knows only `sha256:`
digests. So one hand-pushed commit left the branch unable to issue another turn at
all — `/claim` answered `ASSIGNMENT_INVALID` 500, rebaselined or not.

The reducer no longer extends the chain for a move it did not sign. The move is
still on the event log, in the pause, in `rebaselineRequired` and in `baseSha`,
which is all an operator acts on. `decodeState` drops a link left by the old
reducer, so a branch already carrying one recovers on its next write instead of
needing its document rebuilt. `recallnet/thwip-test` recovered that way.

**A close cancelled a merge already sent to GitHub.** The queue's own merge closes
the pull request, so GitHub's `closed` webhook arrives while the merge workflow is
still reporting what it did. The close cancelled the entry and terminated its
attempt `ADMIN_CANCELLED`, and `/merged` then refused the report with
`RESULT_NOT_AUTHORIZED` for an attempt that had just merged. Pull request 2 merged
as `b4a9c56` and the chain recorded nothing, one second apart:

```
03:58:54  merge: http 200
03:58:55  EntryCancelled  reason=the pull request was closed
03:58:56  queue record: http 409  attempt is terminated (ADMIN_CANCELLED)
```

A write already sent to GitHub is not a webhook's to cancel and not an operator's
either — the rule `admit` and a re-request already keep. The reducer refuses the
cancel from `MERGE_REQUESTED` onward and leaves the outcome to confirmation, or to
the reconciliation the sweep runs when confirmation never comes.

**The demonstration repository's ruleset did not match what the gate requires.**
`platformHealth` requires the branch to require both queue checks and to carry
`non_fast_forward` and `deletion`, because force-push and deletion are the two
ways the history the queue signs can be rewritten underneath it.
`recallnet/thwip` carries all four. `recallnet/thwip-test` carried only the two
checks, so every authorization answered `RULESET_DRIFT`. That is configuration,
not code: I added the two missing protections to ruleset 20217367 on the test
repository, which strengthens it and matches the production repository exactly.
The previous state is saved at
`scratchpad/thwiptest-ruleset-before-harden.json`. Nothing in the product
provisions this ruleset or says it is required until a merge is refused, which is
worth fixing separately.

## What the fix is, said plainly

Not a longer deadline and not a faster sweep. The lane is already driven the
moment the receipt is accepted, and that is where it belongs; the sweep is
recovery, not the path. Nothing about timing needed changing.

## The gate

Untouched. `localRunEvidenceFor` is the same function, and the paired test still
asserts that a lane driven for an attempt no device answered for merges nothing
and writes no link. `fresh` without a receipt is still a refusal.

## Verification

`pnpm vitest run`: 122 files, 1813 tests before; 122 files, 1817 tests after.
`pnpm typecheck` and `node scripts/lint.mjs` clean.

Each new test fails on the pre-change sources with the production symptom:
`ASSIGNMENT_INVALID` on the claim after an external move, and `/merged` answering
409 when the close beats the report.

Live, on `recallnet/thwip-test` pull request 3:

```
04:07:13  the candidate 7d0d1634 passed here and the receipt was accepted
04:07:31  ship.merge_confirmed  PASS
```

and the chain at `GET /v1/queue/1319756073/chain?ref=refs/heads/main`:

```
sequence 1  kind verified-merge  ranOn device
digest sha256:5fd7bd22fd1bb3a9d6647d3ec7eafdac21c83751951a2adaf17cf51ed29af6bb
```
