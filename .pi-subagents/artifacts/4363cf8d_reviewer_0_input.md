# Task for reviewer

You are reviewing PR #316 in the repo at /Users/carsonfarmer/Developer/Recall/thwip (a Git-native CI-proof tool with a merge queue; control plane is a Cloudflare Worker in apps/control-plane). Do a full code review: correctness, product impact, test quality, silent-failure risks. Read the actual files (the main checkout is at main; the PR's change is described below — apply it mentally against the code you read, or fetch the branch with git).


PR #316 "Queue: withdraw draft entries instead of leaving them blocked" (branch wt-draft-cleanup, base main)

The repo is at /Users/carsonfarmer/Developer/Recall/thwip (main checkout, WITHOUT the change applied). The PR branch is pushed at origin/wt-draft-cleanup. Issue: #315. Prior related PR: #314 (drafts can't join the queue) which is merged.

THE FULL DIFF:

diff --git a/apps/control-plane/src/index.ts
@@ import section
-import { driveQueue } from "./queue/drive-queue.js";
+import { driveQueue, HOLDING } from "./queue/drive-queue.js";

@@ in queueFromPullRequest (webhook handler for pull_request events), after the "placed" read:
  // A draft gets no entry: it cannot take a turn, and ready_for_review runs
  // this walk again with draft: false, which admits it then. An entry that
  // predates this rule — or a ready pull request that became a draft — gets
  // withdrawn rather than left blocking the waiting list: drafts hold no place
  // in line, and marking the pull request ready re-joins it at the back through
  // requestTurn's resetOrdinal path. A draft mid-turn is left alone: the
  // merge gate already refuses it, the failed attempt frees the lane, and the
  // next event withdraws it.
  if (pr?.draft === true) {
    if (placed === undefined) {
      return { handled: true, detail: "draft pull requests join the queue when marked ready" };
    }
    if (!HOLDING.includes(placed.state)) {
      await runOnQueue(
        env,
        String(repositoryId),
        ref,
        ({ commands }) =>
          commands.cancel({
            idempotencyKey: `webhook:draft:${entryId}:${headSha}`,
            entryId,
            actorPrincipalId: "github",
            reason: "the pull request is a draft; it rejoins when marked ready",
          }),
        // No turn-check publish: a draft was never offered a turn, so there is
        // no check to update. The status comment does have to move — it is the
        // only surface that says the entry left the line.
        undefined,
        (snapshot) => publishStatusCommentsFor(env, String(repositoryId), ref, snapshot),
      );
      return { handled: true, detail: "draft pull request withdrawn; it rejoins when marked ready" };
    }
  }

diff --git a/apps/control-plane/src/queue/drive-queue.ts
 /** The states in which an entry is the one the lane belongs to. */
-const HOLDING = ["Offered", "Active", "Verifying", "MergeGuard", "Merging"];
+export const HOLDING = ["Offered", "Active", "Verifying", "MergeGuard", "Merging"];

diff --git a/apps/control-plane/src/queue/status-comment-publication.test.ts
     // in test "edits the one it wrote rather than adding another": after converted_to_draft
     expect(comments[0]!.body).toContain("cancelled · this entry left the queue");
     // (was toContain("draft"))

diff --git a/apps/control-plane/src/queue/webhook-enrolment.test.ts
+  it("withdraws an entry left by a draft, and re-admits it when marked ready", async () => {
+    // opened (no proof) -> entry exists; converted_to_draft -> Cancelled; acceptProof + ready_for_review -> Active
+  });



Key verification questions (investigate by reading the code, not by trusting the diff's comments):

1. HOLDING completeness: drive-queue.ts exports HOLDING = ["Offered","Active","Verifying","MergeGuard","Merging"]. Enumerate ALL queue entry states (packages/queue-domain/src/reducer.ts and events.ts). Are there mid-turn states NOT in HOLDING (candidates: "ReconnectGrace", "Reconciling")? If an entry in such a state holds an active attempt and the PR becomes a draft, this PR's code cancels the entry. Trace reducer cancel semantics for an entry with a live currentAttemptId — does cancel on an in-flight attempt corrupt the lane, leave an orphaned attempt, or fail? Compare with how drive-queue.ts uses HOLDING (const holder = entries.find(e => HOLDING.includes(e.state))) — is the set right for that too, or was HOLDING written for driveQueue's narrower purpose?

2. Cancel on Cancelled: a draft PR that gets synchronize/push events after withdrawal re-enters this branch with placed.state === "Cancelled" (not in HOLDING) and a NEW headSha, so the idempotency key differs and commands.cancel runs again on a Cancelled entry. What does the reducer do on cancel of an already-cancelled entry — noop, error, or worse?

3. Cancel on other non-HOLDING states: Requested, Ready, Blocked, Deferred, NeedsRepair. Read the reducer's cancel case for each. Any state where cancel is illegal or wedges the lane?

4. Rejoin correctness: after withdrawal, ready_for_review re-runs queueFromPullRequest: placed is the Cancelled entry, sponsorPrincipalId = placed.sponsorPrincipalId, then authorizeTurn -> admit -> requestTurn. Trace requestTurn in queue-operations.ts for a Cancelled entry (resetOrdinal path) — confirm the entry is rebuilt at the back and becomes schedulable. Check idempotency-key reuse (readinessBucket minute bucket) — can a re-admission in the same minute silently drop the readiness evaluation and leave the entry Requested? Is that state surfaced anywhere harmful (dashboard vocabulary entryStateText("Requested"), status comment states)?

5. Turn-check publish: the code deliberately passes undefined for the turn-check publisher. Check the alternative (closed-PR path) publishes via publishTurnCheckFor — would a draft withdrawal ever need a turn check updated (e.g., an entry that WAS offered... but drafts can't be offered; verify this invariant — can an entry with an existing turn check on its commit ever reach the withdraw branch?).

6. Status comment: after cancel, publishStatusCommentsFor renders the entry as CommentState "cancelled". Verify commentViews includes Cancelled entries and the render says "cancelled · this entry left the queue" (status-comment.ts). Note the comment does not say WHY (draft) or that it rejoins on ready — judge whether that's a product defect or acceptable.

7. HOLDING export side effects: drive-queue.ts now exports HOLDING. Any other consumer? Any shadowing/naming issues?

8. The status-comment-publication.test.ts change: the old test asserted the comment contains "draft" after converted_to_draft; now it asserts "cancelled · this entry left the queue". Is the OLD behavior (blocked draft entry with a draft comment) still reachable anywhere (e.g., mid-turn draft entries), and does the draft CommentState still have a producer? If the draft state is now unreachable, is that dead code?

9. Webhook ordering: converted_to_draft then ready_for_review in rapid succession — any race in runOnQueue/publishStatusCommentsFor?

10. queueFromPullRequest's early return on withdraw skips driveQueue (unlike the closed path). If the withdrawn entry was Ready and next in line, the next eligible entry's turn is offered... when? Is there a regression in turn-offer latency vs the closed path which calls driveQueue? (Check driveQueue — it returns 0 for non-holders, so what actually offers the next turn after a Ready entry is cancelled? Does cancel itself tick the scheduler inside the transaction?)


Report in the code-reviewer format: verdict (APPROVE / APPROVE WITH NOTES / REQUEST CHANGES), blockers with file:line, code issues, missing tests, quality gates. Verify quality gates by running: pnpm vitest run apps/control-plane/src (from the repo root — but note the checkout is main without the change; to test the change, use git worktree add /tmp/review-wt origin/wt-draft-cleanup and run pnpm install --offline && pnpm -r --filter './packages/**' build first). Keep it grounded: every finding needs file:line evidence.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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