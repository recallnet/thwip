/**
 * What "last verification" means, in one place.
 *
 * A verification reaches the database by two routes. The App writes
 * `proof_verifications` when it judges a proof itself. `verification_observations`
 * records what was seen happen elsewhere. Either can be the most recent.
 *
 * The dashboard used to answer the question two different ways. The operations
 * view took whichever row was newest. The project list preferred
 * `proof_verifications` unconditionally, so a newer observation sat hidden
 * behind an older verification and the two screens disagreed about the same
 * project.
 *
 * The preference also split a row in half: `outcome` and the timestamp were
 * two separate COALESCE expressions, so a completed verification with no
 * outcome took its outcome from an observation and its timestamp from the
 * verification. That pair described no event that ever happened.
 *
 * So both columns come from one row, chosen by time.
 */
export function latestVerification(column: "outcome" | "at", projectColumn = "p.id"): string {
  return `(SELECT ${column} FROM (
             SELECT outcome, completed_at AS at FROM proof_verifications
               WHERE project_id = ${projectColumn} AND status = 'completed' AND completed_at IS NOT NULL
             UNION ALL
             SELECT outcome, observed_at AS at FROM verification_observations
               WHERE project_id = ${projectColumn} AND observed_at IS NOT NULL
           ) ORDER BY at DESC LIMIT 1)`;
}
