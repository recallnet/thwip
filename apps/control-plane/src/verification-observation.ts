import { acquireProjectWriteLease } from "./project-lifecycle.js";
import type { D1Like } from "./queue/projection.js";

export interface VerificationObservationInput {
  readonly repositoryId: string;
  readonly projectId: string;
  readonly headSha: string;
  readonly outcome: string;
  readonly runId: string | null;
}

/**
 * Record telemetry only in the project incarnation that issued the bundle.
 *
 * A GitHub Action can run for several minutes. The repository may be removed
 * and selected again while it runs, so repository identity alone is not
 * authority to write into the new project. The exact project id comes from the
 * signed bundle and is held under one lifecycle lease through the insert.
 */
export async function recordVerificationObservation(
  db: D1Like,
  input: VerificationObservationInput,
): Promise<boolean> {
  const lease = await acquireProjectWriteLease(db, input.repositoryId, input.projectId);
  if (lease === null) return false;
  try {
    const result = await db
      .prepare(
        `INSERT INTO verification_observations (project_id, head_sha, outcome, run_id)
         SELECT p.id, ?, ?, ?
           FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ? AND p.github_repository_id = ? AND p.enabled = 1 AND o.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM project_release_requests r
               WHERE r.github_repository_id = p.github_repository_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_release_jobs j
               WHERE j.github_repository_id = p.github_repository_id
            )`,
      )
      .bind(input.headSha, input.outcome, input.runId, input.projectId, input.repositoryId)
      .run();
    return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
  } finally {
    await lease.release();
  }
}
