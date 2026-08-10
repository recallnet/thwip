# Task for reviewer

Adversarially verify the latest state of branch codex/derive-stale-candidate in worktree /Users/carsonfarmer/Developer/Recall/thwip-worktrees/codex-derive-stale-candidate (HEAD 4e01f7f, rebased onto current main).

Context: a prior peer review (on PR #276) found that rename-with-edit and directory renames let a WRONG tree through to main under the fast profile; that has now been fixed. The fix replaced a blob-identity rename guard with: (a) declining derivation whenever GitHub's compare reports a `renamed` status on either side, BEFORE any write, and (b) reading the written tree back and comparing it entry-for-entry against the merge this code computed. A differential test against real `git merge-tree --write-tree` was added.

Read in full:
- apps/control-plane/src/queue/derive-candidate.ts (the module)
- apps/control-plane/src/queue/derive-candidate.test.ts (the tests, including the differential test against real git)
- apps/control-plane/src/queue/github-port.ts (resolveCandidate, the GitHubHttp port and its compare/trees/commits shapes)
- apps/control-plane/src/queue/candidate.ts (pinCandidate's invariants)
- apps/control-plane/src/queue/merge-write.ts (how the pinned tree eventually lands)
- apps/control-plane/src/index.ts around line 2278 (the wiring)

Attack these claims without trusting them:
1. "Decline on any compare `renamed` status closes every rename-crossing divergence." Does compare report `renamed` for every rename git's ort detects — including renames involving content edits, directory renames, and renames the merge OUTCOME moved? Is there any rename shape git resolves or conflicts on where GitHub's compare reports `added`/`removed` instead of `renamed`? Specifically: a rename+edit where the edit is large (similarity below GitHub's threshold) — compare reports `removed`+`added`, and the decline does NOT fire; does entry-level then produce a wrong tree there? Trace it.
2. The moved-sha heuristic was removed entirely. Are there now any cases the old guard caught that compare-rename-decline misses (e.g., identical-content file replaced at a new path with NO rename detection because content is identical — add/add identical but ancestor had it elsewhere)?
3. Cross-check direction: `derivedDelta ⊆ headDelta`. With the written-tree readback now added, is the subset check still load-bearing, or redundant? Could a wrong tree pass both (equals merged entries, and only touches head-touched paths) yet still diverge from git — e.g., a tree that is correct entry-for-entry against the computed merge but the computed merge itself diverged from a true clean merge because the merge base is wrong (multiple merge bases)?
4. Race: the base moves between the base-ref read inside deriveCandidate and the compare reads. What can be stale? Does reading the base ref again, or deriving the base-side delta, pin anything?
5. The compare reads happen BEFORE the tree walks; the readback happens AFTER the commit POST. Is the order such that a bail after the POST (readback mismatch) leaves ONLY an unreferenced object, never a partially written tree referenced by anything? Are deletes (sha: null) in the tree delta ordered safely before/after blob adds touching the same directory, given the D/F collision check is computed before the POST and the readback verifies the stored tree?
6. Cost: deriveCandidate now issues ~14 GitHub API reads plus writes per stale recovery, and is called by BOTH the authorize route AND the device claim route (итика routes.ts:1278) and again before the merge write. Is derivation cached per turn? What stops a tight poll loop from minting many orphan commits?
7. Is anything in the test file actually a differential test the way the reviewer asked (randomised scenarios)? Or is it still a fixed set of hand-picked cases that could agree with the implementation?

Return: falsified claims with evidence (preferably small git reproductions you run yourself), suspicious areas, verified claims, and a concrete list of any further fixes needed before this is safe to mark ready. Compare against the prior review's Critical C1/C2/C3 — has each genuinely closed?

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