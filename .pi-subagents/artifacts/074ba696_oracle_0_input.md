# Task for oracle

Reason hardest about the correctness of deriveCandidate at /Users/carsonfarmer/Developer/Recall/thwip-worktrees/codex-derive-stale-candidate/apps/control-plane/src/queue/derive-candidate.ts (read it, plus candidate.ts and github-port.ts).

The design: when GitHub's synthetic PR merge ref is stale (its first parent is not the current base, and GitHub will not rebuild it on any schedule the queue controls), the queue derives the candidate by entry-level three-way merge of the recursive tree listings, but FIRST declines if GitHub's compare reports any `renamed` status on either side, and AFTER writing the tree+commit reads the tree back and asserts it equals the merge this code computed. A differential test against `git merge-tree --write-tree` was added.

I want steel-manning against these questions, with concrete reproducers you construct and run (or trace precisely):
1. Is "decline on any compare renamed" complete? Investigate GitHub's compare renaming thresholds: a rename+edit with a LARGER edit (similarity below ~50%) is reported by compare as `removed` + `added`, NOT `renamed`. In that case the decline does not fire. What entry-level then produces — is it ever wrong vs git? For rename+edit-below-threshold with an UNRELATED same-path change on the other side, is there a divergence that lands a wrong tree? Construct the smallest such case.
2. The compare reads include base-side (compare mergeBase…base) and head-side (compare mergeBase…head). compare's `files` lists per-file changes from merge-base to that tip. Does it list renamed files reliably when the rename only changes MODE (not content)? When it's a directory rename, are the per-file entries `renamed` or `added`/`removed`?
3. Is there a class of merge where git conflicts and produces a CONFLICT tree, but GitHub's compare reports no `renamed` AND the entry-level merge answers cleanly? That is the load-bearing residual risk. Enumerate the conflict shapes git can produce (content conflict, rename/delete, rename/rename, modify/delete, D/F, ...) and for each decide whether the entry-level + compare-rename-decline + subset cross-check + readback either declines or produces the git answer.
4. Multiple merge bases (criss-cross): compare returns ONE merge_base_commit. The entry-level merge against it can silently drop a head-side change relative to git's recursive virtual base. Does the subset cross-check (derivedDelta ⊆ headDelta) catch this? Does the readback? If neither, give the smallest criss-cross case where a wrong tree is pinned.
5. The differential test is fixed scenarios, not randomised. The reviewer's #4 asked for "randomised scenarios". Is the fixed set enough to trust the claim, or is there a known likelihood a randomised fuzzer would find a counterexample the fixed set misses?

Give a clear, concrete verdict per question — including, where you can, the exact git reproduction. Do not hedge.

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