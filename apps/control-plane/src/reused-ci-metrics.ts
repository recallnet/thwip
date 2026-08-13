import type { InTotoStatementV1 } from "@thwip/protocol";
import type { D1Like } from "./queue/projection.js";

/** Signed durations copied only after the complete proof verification passes. */
export interface SignedProofDurations {
  readonly suiteDurationMs: number;
  readonly wallClockDurationMs: number;
}

/**
 * Read durations from the verified statement without making them part of proof
 * acceptance. An old proof with an unsafe metric remains a valid proof; it is
 * simply honest partial data rather than an inflated product number.
 */
export function signedProofDurations(statement: InTotoStatementV1): SignedProofDurations | null {
  const started = Date.parse(statement.predicate.run.startedAt);
  const finished = Date.parse(statement.predicate.run.finishedAt);
  const wallClockDurationMs = finished - started;
  if (!Number.isSafeInteger(wallClockDurationMs) || wallClockDurationMs < 0) return null;

  let suiteDurationMs = 0;
  for (const suite of statement.predicate.run.suites) {
    if (!Number.isSafeInteger(suite.durationMs) || suite.durationMs < 0) return null;
    suiteDurationMs += suite.durationMs;
    if (!Number.isSafeInteger(suiteDurationMs)) return null;
  }
  return { suiteDurationMs, wallClockDurationMs };
}

interface CompletionInput {
  readonly outcome: string;
  readonly detail?: string;
  readonly policyDigest: string | null;
  readonly durations?: SignedProofDurations;
}

/**
 * Complete one verification and, only for an accepted proof with safe signed
 * durations, store its measurements and the separate control-plane overhead.
 */
export async function recordProofCompletion(
  db: D1Like,
  id: string,
  evaluation: CompletionInput,
  auditJws: string,
  completedAt: string,
): Promise<void> {
  const durations = evaluation.outcome === "PASS" ? evaluation.durations : undefined;
  await db
    .prepare(
      `UPDATE proof_verifications
          SET status = 'completed', outcome = ?, detail = ?, policy_digest = ?, audit_jws = ?, completed_at = ?,
              signed_suite_duration_ms = ?, signed_wall_clock_duration_ms = ?,
              verification_duration_ms = CASE
                WHEN ? IS NULL THEN NULL
                ELSE MAX(0, CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER))
              END
        WHERE id = ?`,
    )
    .bind(
      evaluation.outcome,
      evaluation.detail ?? null,
      evaluation.policyDigest,
      auditJws,
      completedAt,
      durations?.suiteDurationMs ?? null,
      durations?.wallClockDurationMs ?? null,
      durations?.suiteDurationMs ?? null,
      completedAt,
      id,
    )
    .run();
}

export type ReusedCiMetricScope =
  | { readonly kind: "public" }
  | { readonly kind: "organization"; readonly organizationId: string }
  | { readonly kind: "project"; readonly projectId: string };

export interface ReusedCiMetrics {
  /** Complete means every known reused merge has measurements. */
  readonly status: "empty" | "partial" | "complete";
  /** Signed suite time carried by the proofs cited by measured merges. */
  readonly signedSuiteDurationMs: number;
  /** Signed run window carried by the proofs cited by measured merges. */
  readonly signedWallClockDurationMs: number;
  /** Control-plane time spent verifying those proofs. */
  readonly verificationOverheadMs: number;
  /** Reused merges whose cited proof has all three measurements. */
  readonly mergedProofs: number;
  /** Reused merge records in this scope, including pre-metric records. */
  readonly knownReusedMerges: number;
  readonly unmeasuredMergedProofs: number;
}

interface AggregateRow {
  known_reused_merges: number;
  measured_merged_proofs: number;
  signed_suite_duration_ms: number;
  signed_wall_clock_duration_ms: number;
  verification_overhead_ms: number;
}

/**
 * Aggregate existing authority rather than incrementing a counter.
 *
 * A row counts only when a chain-positioned signed transition says
 * `reused-proof-merge` and its cited App verification agrees on project,
 * check run, head commit and policy. Grouping by transition digest protects the
 * total even if bad historical data repeats a check-run id.
 */
export async function reusedCiMetrics(db: D1Like, scope: ReusedCiMetricScope): Promise<ReusedCiMetrics> {
  const where =
    scope.kind === "project"
      ? "AND p.id = ?"
      : scope.kind === "organization"
        ? "AND p.organization_id = ?"
        : "";
  const binding = scope.kind === "public" ? [] : [scope.kind === "project" ? scope.projectId : scope.organizationId];
  const row = await db
    .prepare(
      `WITH reused_merges AS (
         SELECT qa.digest,
                p.id AS project_id,
                json_extract(qa.bytes, '$.reusedProof.checkRunId') AS check_run_id,
                json_extract(qa.bytes, '$.reusedProof.headSha') AS head_sha,
                json_extract(qa.bytes, '$.reusedProof.policyDigest') AS policy_digest
           FROM queue_attestations qa
           JOIN projects p ON p.github_repository_id = qa.github_repository_id
          WHERE qa.transition_sequence IS NOT NULL
            AND qa.kind = 'reused-proof-merge'
            AND json_valid(qa.bytes)
            AND json_extract(qa.bytes, '$.kind') = 'reused-proof-merge'
            AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
            AND NOT EXISTS (
              SELECT 1 FROM project_release_jobs r
               WHERE r.organization_id = p.organization_id
                 AND r.github_repository_id = p.github_repository_id
            )
            ${where}
       ), joined AS (
         SELECT rm.digest,
                v.signed_suite_duration_ms AS suite_ms,
                v.signed_wall_clock_duration_ms AS wall_ms,
                v.verification_duration_ms AS verification_ms,
                ROW_NUMBER() OVER (PARTITION BY rm.digest ORDER BY v.completed_at DESC, v.id DESC) AS match_number
           FROM reused_merges rm
           LEFT JOIN proof_verifications v
             ON v.project_id = rm.project_id
            AND v.check_run_id = rm.check_run_id
            AND v.subject_sha = rm.head_sha
            AND v.policy_digest = rm.policy_digest
            AND v.status = 'completed'
            AND v.outcome = 'PASS'
            AND v.completed_at IS NOT NULL
            AND length(v.verifier_version) > 0
            AND v.signed_suite_duration_ms >= 0
            AND v.signed_wall_clock_duration_ms >= 0
            AND v.verification_duration_ms >= 0
       ), qualified AS (
         SELECT digest, suite_ms, wall_ms, verification_ms
           FROM joined
          WHERE match_number = 1
       )
       SELECT COUNT(*) AS known_reused_merges,
              COUNT(CASE WHEN suite_ms IS NOT NULL AND wall_ms IS NOT NULL AND verification_ms IS NOT NULL THEN 1 END)
                AS measured_merged_proofs,
              COALESCE(SUM(CASE WHEN wall_ms IS NOT NULL AND verification_ms IS NOT NULL THEN suite_ms ELSE 0 END), 0)
                AS signed_suite_duration_ms,
              COALESCE(SUM(CASE WHEN suite_ms IS NOT NULL AND verification_ms IS NOT NULL THEN wall_ms ELSE 0 END), 0)
                AS signed_wall_clock_duration_ms,
              COALESCE(SUM(CASE WHEN suite_ms IS NOT NULL AND wall_ms IS NOT NULL THEN verification_ms ELSE 0 END), 0)
                AS verification_overhead_ms
         FROM qualified`,
    )
    .bind(...binding)
    .first<AggregateRow>();

  const known = row?.known_reused_merges ?? 0;
  const measured = row?.measured_merged_proofs ?? 0;
  return {
    status: known === 0 ? "empty" : measured < known ? "partial" : "complete",
    signedSuiteDurationMs: row?.signed_suite_duration_ms ?? 0,
    signedWallClockDurationMs: row?.signed_wall_clock_duration_ms ?? 0,
    verificationOverheadMs: row?.verification_overhead_ms ?? 0,
    mergedProofs: measured,
    knownReusedMerges: known,
    unmeasuredMergedProofs: known - measured,
  };
}

/** Public totals stay hidden until enough measured merges make up the sample. */
export const PUBLIC_METRICS_MINIMUM_MERGED_PROOFS = 10;

export type PublicReusedCiMetrics =
  | { readonly status: "insufficient-sample"; readonly minimumMergedProofs: number }
  | ({ readonly minimumMergedProofs: number } & ReusedCiMetrics);

export function publicReusedCiMetrics(metrics: ReusedCiMetrics): PublicReusedCiMetrics {
  if (metrics.mergedProofs < PUBLIC_METRICS_MINIMUM_MERGED_PROOFS) {
    return { status: "insufficient-sample", minimumMergedProofs: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS };
  }
  return { ...metrics, minimumMergedProofs: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS };
}
