import type Database from "better-sqlite3";

/**
 * The App's own passing verdict on a head, written the way it is really
 * written.
 *
 * The queue reads `proof_verifications` to decide whether a head's proof
 * passed. It used to read `proofAccepted` off the request body, so every test
 * about queue behaviour asserted the fact rather than establishing it — which
 * is the shape of the bug the read exists to close, reproduced in the suites
 * that were supposed to catch it.
 *
 * A test about lanes and turns should not have to restate how a verification is
 * stored, so this does it once. Callers own the project row; this refuses
 * rather than inventing one, because a verdict attached to a project the test
 * did not set up would silently pass for the wrong repository.
 */
export function acceptProof(raw: Database.Database, repositoryId: string, headSha: string): void {
  const project = raw
    .prepare("SELECT id FROM projects WHERE github_repository_id = ? LIMIT 1")
    .get(repositoryId) as { id: string } | undefined;
  if (project === undefined) {
    throw new Error(`no project row for repository ${repositoryId}; seed one before accepting a proof for it`);
  }
  raw
    .prepare(
      `INSERT OR REPLACE INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json,
          status, outcome, check_name, started_at, completed_at)
       VALUES (?, ?, 'pull_request', ?, 'refs/heads/main', 'test', 'enforced', '{}', 'completed', 'PASS', 'thwip',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')`,
    )
    .run(`pv_${repositoryId}_${headSha}`, project.id, headSha);
}
