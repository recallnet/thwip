import type { D1Like } from "./projection.js";

/**
 * Whether the App's own verification of a head passed.
 *
 * The gate used to take this from the caller. `/authorize` read `proofAccepted`
 * off a request body composed by a workflow inside the branch under test, and
 * the `pull_request` webhook could not assert it at all, so every entry the
 * webhook placed read `LOCAL_RECEIPT_MISSING` and no pull request GitHub
 * delivered could become ready on its own.
 *
 * The App already holds the answer. `processAppProofVerification` runs
 * `verifyProof` over the same head the check covers and writes the verdict to
 * `proof_verifications`, so the queue reads a row it wrote.
 *
 * Two rules, and both of them are the reason this is a function rather than a
 * join somebody writes again:
 *
 * - Absence is not a pass. A head nothing has verified reads false, and the
 *   entry waits, rather than falling through to whatever the caller claimed.
 * - The newest completed answer is the answer. A head verified again under a
 *   policy that has since changed can turn a `PASS` into a refusal, and the
 *   older row must not go on speaking for it.
 */
export async function headProofAccepted(db: D1Like, repositoryId: string, headSha: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT v.outcome AS outcome
         FROM proof_verifications v
         JOIN projects p ON p.id = v.project_id
        WHERE p.github_repository_id = ?
          AND v.subject_sha = ?
          AND v.status = 'completed'
          AND v.completed_at IS NOT NULL
        ORDER BY v.completed_at DESC
        LIMIT 1`,
    )
    .bind(repositoryId, headSha)
    .first<{ outcome: string | null }>();
  return row?.outcome === "PASS";
}
