# Task for reviewer

Adversarially verify a proposed change in the git worktree at /Users/carsonfarmer/Developer/Recall/thwip-worktrees/codex-derive-stale-candidate (branch codex/derive-stale-candidate, diff vs origin/main).

The change: when GitHub's synthetic PR merge ref is stale (first parent != current base, which GitHub no longer rebuilds on any schedule the queue controls), the queue derives the merge candidate itself: an entry-level three-way tree merge over recursive tree listings, written as an unreferenced commit object via the GitHub Git API.

Files to read in full:
- apps/control-plane/src/queue/derive-candidate.ts (the new module)
- apps/control-plane/src/queue/derive-candidate.test.ts (its tests)
- apps/control-plane/src/queue/github-port.ts (resolveCandidate, the existing resolver)
- apps/control-plane/src/queue/candidate.ts (pinCandidate, the pin invariants)
- apps/control-plane/src/index.ts around line 2278 (the wiring, integratedCandidate)
- apps/control-plane/src/queue/merge-write.ts (how the pinned tree is eventually written)

Attack these claims without trusting them:
1. "When mergeTreeEntries answers, the result equals git's own three-way merge tree, because every path's result is forced." Try to construct a counterexample: renames, mode-only changes, gitlinks, empty directories appearing/disappearing, D/F collisions, criss-cross merge bases, paths present in one tree but a prefix-dir in another.
2. "Every bail path writes nothing and leaves the lane exactly as before." Check every early return: can any API write happen before a bail? Can a partial write leave state?
3. "Unreferenced commits created via POST /git/commits are fetchable by full sha from GitHub." Is there any documented or behavioral reason this might fail for the verify workflow's actions/checkout or the CLI's git fetch?
4. "mergeable===true is a fresh GitHub verdict even when merge_commit_sha is stale." Any way mergeable is as stale as the ref?
5. Race: the base moves BETWEEN the base-ref read inside deriveCandidate and the final merge write. What pins the write to the derived base? (Check merge-write.ts's fast-forward guard and the intent parents.)
6. Race: two concurrent derivations for the same PR (two ticks). What breaks?
7. The echo read-back after POST /git/commits — redundant with the POST response, or genuinely load-bearing?
8. Any way a WRONG tree lands on main under the fast profile (no suite runs against the merged tree before write).

Also hunt for: duplicated logic that already exists elsewhere in the repo (e.g., gitOid helpers, response shapes), dead or over-defensive code, and LOC that could be deleted without losing a safety property. The repo's stated preference is correct-by-design over defence-in-depth.

Report: falsified claims with evidence, suspicious areas, verified claims, and a concrete list of deletable/redundant lines with reasons.

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