# Task for oracle

Deep-reasoning review of a merge-candidate derivation in /Users/carsonfarmer/Developer/Recall/thwip-worktrees/codex-derive-stale-candidate — read apps/control-plane/src/queue/derive-candidate.ts and its test, plus apps/control-plane/src/queue/candidate.ts (pinCandidate) and apps/control-plane/src/queue/github-port.ts (resolveCandidate).

The design: when a GitHub PR's synthetic merge ref is stale (GitHub's 2026-02 rules no longer rebuild it after a base move), derive the candidate via an entry-level three-way merge of the recursive tree listings (merge-base, base, head), write the merged tree with POST /git/trees base_tree+delta, create an unreferenced commit with parents [base, head], and pin that as the candidate. Bail to the prior stale-retry behavior on any ambiguity.

Reason hardest about:
1. Exactness: is entry-level resolution (take the side that differs from the ancestor; bail if both differ) ALWAYS equal to git merge (ort) when it answers? Consider: rename detection interactions (ort pairs a delete+add as a rename and may then content-merge the renamed file with the other side's modification of the OLD path — can entry-level answer where ort would have conflicted or vice versa, and can entry-level produce a tree ort would not?), submodule/gitlink semantics, symlink mode changes, file<->dir type changes on ONE side only, and the case where the merge base returned by the compare API is not the one ort would choose (multiple merge bases).
2. Is mergeable===true checked against the same base the derivation reads? What if GitHub computed mergeability against base B0 and derivation reads base B1 (base moved in between)? Does the entry-level merge against B1 stay exact even though mergeability referred to B0? Could a conflict exist against B1 while mergeable says true, and could entry-level then produce a silently wrong tree rather than bailing?
3. The POST /git/trees delta semantics with base_tree: are there path-encoding, sorting, or mode-normalization gotchas (e.g., paths with special characters, unicode normalization, trailing slashes)? Does deletion via sha:null interact correctly with base_tree?
4. Is creating unreferenced objects on every stale recovery a resource/abuse concern, and does GitHub GC them in a way that could break a pending fetch?
5. Anything about the wiring seam (resolveOrDeriveCandidate called from index.ts integratedCandidate) that could double-derive, race the Durable Object's attempt state, or confuse the attempt's stored candidateSha when a re-authorize derives a different sha for the same tree.

Be concrete: file/line references, counterexample scenarios spelled out step by step, and a clear verdict per question.

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