# Task for delegate

You are an adversarial verifier for PR #316 in the repo at /Users/carsonfarmer/Developer/Recall/thwip. Assume the change is subtly wrong and prove or falsify it. Your job is finding hidden errors, not fixing them.

WHAT THE PR DOES: The pull_request webhook handler (`queueFromPullRequest` in apps/control-plane/src/index.ts) now WITHDRAWS (cancels) a draft PR's queue entry instead of leaving it blocked in place. Logic: if `pr.draft === true` and no entry exists → skip placement; if an entry exists and `!HOLDING.includes(entry.state)` → `commands.cancel(...)` then publish status comments; else (mid-turn) leave alone. HOLDING is exported from apps/control-plane/src/queue/drive-queue.ts as `["Offered","Active","Verifying","MergeGuard","Merging"]`. The change is on branch origin/wt-draft-cleanup; the main checkout is at main WITHOUT the change (the diff: index.ts adds the draft branch in queueFromPullRequest; drive-queue.ts exports HOLDING; two tests updated/added in webhook-enrolment.test.ts and status-comment-publication.test.ts).

VERIFY THESE BY READING CODE (never trust the diff's comments):
1. Enumerate every queue entry state from packages/queue-domain/src/reducer.ts. Which states carry a live attempt (currentAttemptId with outcome null)? Is HOLDING the complete set of "mid-turn" states? Check "ReconnectGrace" (HeartbeatLost sets it while an attempt runs) and "Reconciling" (MergeOutcomeUnknown sets outcomeUnknown=true). What does the reducer's cancel case do for an entry in each of those states — read lines around 886-910 of the reducer carefully. What does `fail()` throw and what does store.append do with it (snapshot-store.ts append: is applyEvent+assertInvariants run BEFORE persisting)?
2. The webhook code ignores the CommandResult from cancel. If cancel is rejected (e.g., "cannot cancel while a merge outcome is unknown"), the webhook still returns detail "draft pull request withdrawn". Trace the exact consequence: what does the webhook HTTP response look like, does the status-comment pass still run, and does the entry state stay Reconciling?
3. Cancel on an already-Cancelled entry (duplicate webhook deliveries / new headSha after withdrawal → new idempotency key → cancel runs again): reducer behavior?
4. Cancel on Requested, Ready, Blocked, Deferred, NeedsRepair: trace each through the reducer's cancel case.
5. Rejoin after withdrawal: ready_for_review → placed is Cancelled → authorizeTurn → admit → requestTurn (queue-operations.ts resetOrdinal path). Confirm the rebuilt entry becomes schedulable. Check the readiness idempotency key `authorize:ready:${entryId}:${headSha}:${readinessBucket}:${decision}` — if the same decision is re-evaluated in the same minute, is the evaluation dropped? What does the entry look like then (state Requested, no reason) and does anything ever re-evaluate it (tick's reconsiderHead)?
6. The claim "drafts can never be offered a turn so a withdrawn entry can never have a published turn check" — verify by tracing where turn checks are published (publishTurnCheckFor callers) and whether a Deferred entry could carry a stale turn check that the withdrawal leaves behind, and whether that's harmful (a required failed check on the commit blocking merge after ready_for_review — does publishTurnCheckFor PATCH the same check run?).
7. Is CommentState "draft" still reachable after this change (status-comment.ts stateOf)? Dead code check.
8. The withdraw path skips driveQueue. If the withdrawn entry was Ready and next in line, what offers the next turn — does withQueueState/runOnQueue's settle tick the scheduler after the cancel write? Compare with the closed-PR path which explicitly calls driveQueue.
9. The two tests added/changed: do they actually pin the behavior or just the current implementation? What's untested that could break silently?

Set up: `git worktree add /tmp/adversarial-wt origin/wt-draft-cleanup` if you want to run code; packages need `pnpm install --offline && pnpm -r --filter './packages/**' build` in that worktree. Output: a table of findings each VERIFIED / SUSPICIOUS / FALSIFIED with file:line evidence, then an overall verdict. Clean up any worktree you create.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```