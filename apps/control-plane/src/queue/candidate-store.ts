import type { CandidateSuite, CandidateVerdict } from "./store.js";
import type { D1Like } from "./projection.js";

/**
 * Candidate verdicts and dispatch claims, in D1 rather than in the Durable Object.
 *
 * Both used to live in the object's own SQLite, so checking candidate progress
 * woke the coordination object to answer a question that has nothing to do with
 * coordination.
 *
 * A verdict is an immutable record keyed by the tree it judged. A dispatch claim
 * is a rate limit. Neither needs serialising against anything, and neither should
 * cost a Durable Object request, which is the resource with a daily cliff. D1 row
 * reads are the cheapest thing on the platform.
 *
 * Nothing about the trust model moves with them. The digest is still computed from
 * the verdict's content by the server, and still recomputed at the merge gate, so
 * where the bytes rest changes nothing about whether they can be believed.
 */

export async function recordCandidateVerdict(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  verdict: CandidateVerdict,
): Promise<{ status: "applied" | "duplicate" }> {
  const existing = await candidateVerdict(db, repositoryId, baseRef, verdict.candidateTreeOid);
  if (existing !== null) return { status: "duplicate" };

  // First writer wins. A second verdict for the same tree is either a retry or a
  // second run reaching the same place; letting a later one overwrite would let a
  // re-dispatched workflow turn a refusal into an acceptance.
  await db
    .prepare(
      `INSERT INTO candidate_verdicts (
         github_repository_id, base_ref, candidate_tree_oid, candidate_sha, base_sha,
         pull_request_number, accepted, result_digest, policy_digest, suites,
         reason_codes, workflow_ref, workflow_sha, run_id, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid) DO NOTHING`,
    )
    .bind(
      repositoryId,
      baseRef,
      verdict.candidateTreeOid,
      verdict.candidateSha,
      verdict.baseSha,
      verdict.pullRequestNumber,
      verdict.accepted ? 1 : 0,
      verdict.resultDigest,
      verdict.policyDigest,
      JSON.stringify(verdict.suites),
      JSON.stringify(verdict.reasonCodes),
      verdict.workflowRef,
      verdict.workflowSha,
      verdict.runId,
      verdict.observedAt,
    )
    .run();
  return { status: "applied" };
}

export async function candidateVerdict(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  candidateTreeOid: string,
): Promise<CandidateVerdict | null> {
  const row = await db
    .prepare(
      `SELECT * FROM candidate_verdicts
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid)
    .first<{
      candidate_tree_oid: string;
      candidate_sha: string;
      base_sha: string;
      pull_request_number: number;
      accepted: number;
      result_digest: string;
      policy_digest: string;
      suites: string;
      reason_codes: string;
      workflow_ref: string;
      workflow_sha: string;
      run_id: string;
      observed_at: string;
    }>();
  if (row === null) return null;
  return {
    candidateTreeOid: row.candidate_tree_oid,
    candidateSha: row.candidate_sha,
    baseSha: row.base_sha,
    pullRequestNumber: row.pull_request_number,
    accepted: row.accepted === 1,
    resultDigest: row.result_digest,
    policyDigest: row.policy_digest,
    suites: JSON.parse(row.suites) as CandidateSuite[],
    reasonCodes: JSON.parse(row.reason_codes) as string[],
    workflowRef: row.workflow_ref,
    workflowSha: row.workflow_sha,
    runId: row.run_id,
    observedAt: row.observed_at,
  };
}

/**
 * Claim the right to ask a verifier to run against this candidate.
 *
 * True only for the caller that should dispatch. The claim goes stale so a run
 * that died without reporting cannot wedge its candidate forever, and the clock
 * restarts from each fresh claim.
 */
export async function claimCandidateDispatch(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  candidateTreeOid: string,
  at: string,
  staleAfterMs: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT dispatched_at FROM candidate_dispatches
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid)
    .first<{ dispatched_at: string }>();

  if (row !== null) {
    const age = Date.parse(at) - Date.parse(row.dispatched_at);
    if (Number.isFinite(age) && age < staleAfterMs) return false;
  }

  await db
    .prepare(
      `INSERT INTO candidate_dispatches (github_repository_id, base_ref, candidate_tree_oid, dispatched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid)
       DO UPDATE SET dispatched_at = excluded.dispatched_at`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid, at)
    .run();
  return true;
}
