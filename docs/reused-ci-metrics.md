# Reused CI measurements

Thwip reports measurements only after a merge reuses a signed proof from the
pull request head. It does not estimate developer time or money saved.

## Definitions

- **Verified local CI reused** is the signed wall-clock run window from
  `run.startedAt` to `run.finishedAt` in the accepted proof cited by the merge.
- **Signed suite duration** is the sum of the signed `durationMs` values for all
  suites in that proof. The API exposes it separately because suites may run in
  parallel, so it is not interchangeable with wall-clock time.
- **Proof verification overhead** is the control-plane time from creating the
  verification row until the proof verdict is ready. It does not include the
  signed local run.
- **Merges that reused a proof** counts signed `reused-proof-merge` records with
  all three measurements. One signed merge record counts once.

A measurement qualifies only when the proof verification passed and its
project, check run, head commit, and active policy match the signed merge
record. Fresh device runs, GitHub-hosted candidate runs, failed proofs, pending
proofs, duplicate deliveries, and signed records that do not occupy a chain
position do not add to these totals.

## Scope and older data

Signed proof measurements are stored on the existing proof-verification row.
That row already binds the project, check run, subject commit, policy, and
verifier version. Organization and project totals use the same access rules as
their dashboard pages.

Rows created before this measurement shipped have no stored duration. The API
reports `partial` when a scope has both measured and older reused merges, and
`empty` when it has none. It does not turn missing history into zero-duration
work.

## Public minimum sample

`GET /v1/metrics` returns no totals until at least 10 measured merges exist
across the deployment. Before that threshold it returns only:

```json
{ "status": "insufficient-sample", "minimumMergedProofs": 10 }
```

At or above the threshold, the endpoint returns totals and counts only. It does
not return organization, repository, user, proof, check-run, or commit
identifiers.
