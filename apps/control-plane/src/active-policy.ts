import type { D1Like } from "./queue/projection.js";

/**
 * What the active policy requires of a candidate.
 *
 * Every value here comes from the activated policy bundle — the document a
 * person reviewed, whose digest every signed record binds. Nothing is taken from
 * a caller or from a column denormalized alongside it.
 *
 * That distinction is not theoretical. The security profile decides whether a
 * merge needs the integrated candidate run, and it used to be read from
 * `projects.security_profile`, which the enrollment endpoint writes from
 * whatever the caller sends, independently of the bundle activated in the same
 * request. The two drifted. This repository's reviewed bundle asked for `fast`
 * — reuse the proof already on the head — while the column said `fresh`, and the
 * column was what the queue obeyed. Every merge dispatched a full candidate
 * verification the policy had never asked for.
 */
export interface ActivePolicy {
  readonly policyDigest: string;
  /** The pipeline the proof had to satisfy, which a merge record binds. */
  readonly pipelineDigest: string | null;
  readonly requiredSuites: readonly string[];
  readonly securityProfile: string;
  /** Evidence keys are tenant-scoped so an export or deletion can be bounded. */
  readonly organizationId: string;
  /** Null when no verifier is pinned, which only matters to a stronger profile. */
  readonly verifier: { workflowRef: string; workflowSha: string | null } | null;
}

export async function readActivePolicy(db: D1Like, repositoryId: string): Promise<ActivePolicy | null> {
  const row = await db
    .prepare(
      `SELECT p.active_policy_digest AS digest, p.organization_id AS org,
              b.canonical_json AS bundle, q.verifier_json AS verifier
         FROM projects p
         JOIN policy_bundles b ON b.digest = p.active_policy_digest
         LEFT JOIN queue_projects q ON q.github_repository_id = p.github_repository_id
        WHERE p.github_repository_id = ?`,
    )
    .bind(repositoryId)
    .first<{ digest: string; org: string; bundle: string; verifier: string | null }>();
  if (row === null) return null;

  const bundle = JSON.parse(row.bundle) as {
    securityProfile?: unknown;
    pipeline?: { requiredSuites?: string[]; digest?: string };
  };

  // A bundle that does not say what it requires cannot be certified against.
  // Falling back to the column would restore exactly the drift this removes.
  if (typeof bundle.securityProfile !== "string" || bundle.securityProfile.length === 0) return null;

  const verifierJson = row.verifier === null ? null : (JSON.parse(row.verifier) as Record<string, unknown>);
  // workflowSha may be null: that pins the workflow's path on the default branch
  // and accepts any revision of it, which is what a repository that merges often
  // can actually keep current.
  const verifier =
    typeof verifierJson?.["workflowRef"] === "string"
      ? {
          workflowRef: verifierJson["workflowRef"],
          workflowSha: typeof verifierJson["workflowSha"] === "string" ? verifierJson["workflowSha"] : null,
        }
      : null;

  return {
    policyDigest: row.digest,
    pipelineDigest: bundle.pipeline?.digest ?? null,
    requiredSuites: bundle.pipeline?.requiredSuites ?? [],
    securityProfile: bundle.securityProfile,
    organizationId: row.org,
    verifier,
  };
}
