import type { CandidateSuite, CandidateVerdict } from "./store.js";
import type { D1Like } from "./projection.js";
import { databaseSchemaCapabilities } from "../schema-state.js";

async function verifierProtocolV3Ready(db: D1Like): Promise<boolean> {
  return (await databaseSchemaCapabilities(db)).verifierProtocolV3;
}

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

/**
 * Temporary protocol-v2 compatibility. This writer is unreachable after the
 * exact project activates v3, and migration 0033 then deletes every v2 verdict.
 */
export async function recordCandidateVerdictV2(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  projectId: string,
  verdict: CandidateVerdict,
): Promise<{ status: "applied" | "duplicate" | "unavailable" }> {
  const existing = await candidateVerdict(db, repositoryId, baseRef, verdict.candidateTreeOid, projectId);
  if (existing !== null) return { status: "duplicate" };
  const v3Ready = await verifierProtocolV3Ready(db);
  const inserted = await db
    .prepare(
      v3Ready ? `INSERT INTO candidate_verdicts (
         github_repository_id, base_ref, project_id, candidate_tree_oid, candidate_sha, base_sha,
         pull_request_number, accepted, result_digest, policy_digest, suites,
         reason_codes, workflow_ref, workflow_sha, run_id, observed_at, verifier_protocol
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2
          WHERE EXISTS (
            SELECT 1 FROM queue_projects q
             JOIN projects p ON p.id = q.project_id
            WHERE q.github_repository_id = ? AND q.base_ref = ? AND q.project_id = ?
              AND q.verifier_protocol <> 3 AND p.github_repository_id = q.github_repository_id
          )
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid) DO NOTHING`
      : `INSERT INTO candidate_verdicts (
         github_repository_id, base_ref, project_id, candidate_tree_oid, candidate_sha, base_sha,
         pull_request_number, accepted, result_digest, policy_digest, suites,
         reason_codes, workflow_ref, workflow_sha, run_id, observed_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM projects p
             WHERE p.id = ? AND p.github_repository_id = ?
          )
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid) DO NOTHING`,
    )
    .bind(...(v3Ready ? [
      repositoryId,
      baseRef,
      projectId,
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
      repositoryId,
      baseRef,
      projectId,
    ] : [
      repositoryId,
      baseRef,
      projectId,
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
      projectId,
      repositoryId,
    ]))
    .run();
  if (((inserted as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1) return { status: "applied" };
  return (await candidateVerdict(db, repositoryId, baseRef, verdict.candidateTreeOid, projectId)) === null
    ? { status: "unavailable" }
    : { status: "duplicate" };
}

export async function candidateVerdict(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  candidateTreeOid: string,
  projectId?: string,
): Promise<CandidateVerdict | null> {
  const v3Ready = await verifierProtocolV3Ready(db);
  const row = await db
    .prepare(
      v3Ready ? `SELECT * FROM candidate_verdicts
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND (? IS NULL OR project_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM queue_projects q
             WHERE q.github_repository_id = candidate_verdicts.github_repository_id
               AND q.base_ref = candidate_verdicts.base_ref
               AND q.project_id = candidate_verdicts.project_id
               AND q.verifier_protocol = 3
               AND candidate_verdicts.verifier_protocol <> 3
          )`
      : `SELECT * FROM candidate_verdicts
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND (? IS NULL OR project_id = ?)`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid, projectId ?? null, projectId ?? null)
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

export interface CandidateDispatchV3 {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateTreeOid: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly pullRequestNumber: number;
  readonly requiredSuites: readonly string[];
  readonly policyDigest: string;
  readonly dispatchNonce: string;
  readonly workflowCommitSha: string;
  readonly workflowBlobSha: string;
  readonly workflowContentDigest: string;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DISPATCH_NONCE = /^verifier_[0-9a-f]{32}$/;
const SUITE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function validRequiredSuites(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 &&
    value.every((suite) => typeof suite === "string" && SUITE_ID.test(suite)) &&
    new Set(value).size === value.length;
}

function validStoredDispatch(row: Record<string, unknown>, requiredSuites: unknown): boolean {
  return typeof row["repositoryId"] === "string" && /^\d+$/.test(row["repositoryId"]) &&
    typeof row["baseRef"] === "string" && row["baseRef"].startsWith("refs/heads/") &&
    typeof row["projectId"] === "string" && row["projectId"].length > 0 &&
    typeof row["attemptId"] === "string" && row["attemptId"].length > 0 &&
    typeof row["candidateTreeOid"] === "string" && OID.test(row["candidateTreeOid"]) &&
    typeof row["candidateSha"] === "string" && OID.test(row["candidateSha"]) &&
    typeof row["baseSha"] === "string" && OID.test(row["baseSha"]) &&
    typeof row["pullRequestNumber"] === "number" && Number.isSafeInteger(row["pullRequestNumber"]) &&
    row["pullRequestNumber"] > 0 && validRequiredSuites(requiredSuites) &&
    typeof row["policyDigest"] === "string" && SHA256.test(row["policyDigest"]) &&
    typeof row["dispatchNonce"] === "string" && DISPATCH_NONCE.test(row["dispatchNonce"]) &&
    typeof row["workflowCommitSha"] === "string" && /^[0-9a-f]{40}$/.test(row["workflowCommitSha"]) &&
    typeof row["workflowBlobSha"] === "string" && /^[0-9a-f]{40}$/.test(row["workflowBlobSha"]) &&
    typeof row["workflowContentDigest"] === "string" && SHA256.test(row["workflowContentDigest"]);
}

export interface CandidateDispatchBindingV2 {
  readonly projectId: string;
  readonly attemptId: string | null;
  readonly workflowProtocol: 1 | 2;
}

/** Keep callbacks from the exact generated v1/v2 workflow shape compatible. */
export function legacyVerifierProtocol(workflowVersion: number): 1 | 2 {
  return workflowVersion === 1 ? 1 : 2;
}

/** Temporary dispatch compatibility for an exact project that has not activated v3. */
export async function claimCandidateDispatchV2(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  projectId: string,
  attemptId: string,
  workflowProtocol: 1 | 2,
  candidateTreeOid: string,
  at: string,
  staleAfterMs: number,
): Promise<boolean> {
  const v3Ready = await verifierProtocolV3Ready(db);
  const row = await db
    .prepare(
      v3Ready ? `SELECT dispatched_at FROM candidate_dispatches
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ? AND verifier_protocol <> 3`
      : `SELECT dispatched_at FROM candidate_dispatches
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ?`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid, projectId)
    .first<{ dispatched_at: string }>();
  if (row !== null) {
    const age = Date.parse(at) - Date.parse(row.dispatched_at);
    if (Number.isFinite(age) && age < staleAfterMs) return false;
  }
  const written = await db
    .prepare(
      v3Ready ? `INSERT INTO candidate_dispatches
         (github_repository_id, base_ref, project_id, attempt_id, workflow_protocol,
          candidate_tree_oid, dispatched_at, verifier_protocol)
       SELECT ?, ?, ?, ?, ?, ?, ?, 2
        WHERE EXISTS (
          SELECT 1 FROM queue_projects q
           WHERE q.github_repository_id = ? AND q.base_ref = ? AND q.project_id = ?
             AND q.verifier_protocol <> 3
        )
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid)
       DO UPDATE SET dispatched_at = excluded.dispatched_at,
                     attempt_id = excluded.attempt_id,
                     workflow_protocol = excluded.workflow_protocol
        WHERE candidate_dispatches.project_id = excluded.project_id
          AND candidate_dispatches.verifier_protocol <> 3`
      : `INSERT INTO candidate_dispatches
         (github_repository_id, base_ref, project_id, attempt_id, workflow_protocol,
          candidate_tree_oid, dispatched_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.github_repository_id = ?)
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid)
       DO UPDATE SET dispatched_at = excluded.dispatched_at,
                     attempt_id = excluded.attempt_id,
                     workflow_protocol = excluded.workflow_protocol
        WHERE candidate_dispatches.project_id = excluded.project_id`,
    )
    .bind(...(v3Ready ? [
      repositoryId,
      baseRef,
      projectId,
      attemptId,
      workflowProtocol,
      candidateTreeOid,
      at,
      repositoryId,
      baseRef,
      projectId,
    ] : [
      repositoryId,
      baseRef,
      projectId,
      attemptId,
      workflowProtocol,
      candidateTreeOid,
      at,
      projectId,
      repositoryId,
    ]))
    .run();
  return ((written as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

export async function candidateDispatchBindingV2(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  candidateTreeOid: string,
  projectId: string,
): Promise<CandidateDispatchBindingV2 | null> {
  const v3Ready = await verifierProtocolV3Ready(db);
  const row = await db
    .prepare(
      v3Ready ? `SELECT d.project_id AS projectId, d.attempt_id AS attemptId,
              d.workflow_protocol AS workflowProtocol
         FROM candidate_dispatches d
         JOIN projects p ON p.id = d.project_id
         JOIN queue_projects q ON q.github_repository_id = d.github_repository_id
          AND q.base_ref = d.base_ref AND q.project_id = d.project_id
        WHERE d.github_repository_id = ? AND d.base_ref = ?
          AND d.candidate_tree_oid = ? AND d.project_id = ?
          AND d.verifier_protocol <> 3 AND q.verifier_protocol <> 3
          AND p.github_repository_id = d.github_repository_id
          AND NOT EXISTS (
            SELECT 1 FROM project_release_requests r
             WHERE r.github_repository_id = d.github_repository_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.github_repository_id = d.github_repository_id
          )`
      : `SELECT d.project_id AS projectId, d.attempt_id AS attemptId,
              d.workflow_protocol AS workflowProtocol
         FROM candidate_dispatches d
         JOIN projects p ON p.id = d.project_id
        WHERE d.github_repository_id = ? AND d.base_ref = ?
          AND d.candidate_tree_oid = ? AND d.project_id = ?
          AND p.github_repository_id = d.github_repository_id
          AND NOT EXISTS (
            SELECT 1 FROM project_release_requests r
             WHERE r.github_repository_id = d.github_repository_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.github_repository_id = d.github_repository_id
          )`,
    )
    .bind(repositoryId, baseRef, candidateTreeOid, projectId)
    .first<{ projectId: string; attemptId: string | null; workflowProtocol: number }>();
  if (row === null || (row.workflowProtocol !== 1 && row.workflowProtocol !== 2)) return null;
  return { projectId: row.projectId, attemptId: row.attemptId, workflowProtocol: row.workflowProtocol };
}

/** Claim one exact v3 run. Old v1/v2 rows may be replaced, but never accepted. */
export async function claimCandidateDispatchV3(
  db: D1Like,
  dispatch: CandidateDispatchV3,
  at: string,
  staleAfterMs: number,
): Promise<boolean> {
  if (!(await verifierProtocolV3Ready(db))) return false;
  const row = await db
    .prepare(
      `SELECT dispatched_at, pending_at, terminal_reason
         FROM candidate_dispatches
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ?`,
    )
    .bind(dispatch.repositoryId, dispatch.baseRef, dispatch.candidateTreeOid, dispatch.projectId)
    .first<{ dispatched_at: string; pending_at: string | null; terminal_reason: string | null }>();
  if (row !== null && row.pending_at !== null && row.terminal_reason === null) return false;
  if (row !== null && row.terminal_reason === null) {
    const age = Date.parse(at) - Date.parse(row.dispatched_at);
    if (Number.isFinite(age) && age < staleAfterMs) return false;
  }

  const written = await db
    .prepare(
      `INSERT INTO candidate_dispatches (
         github_repository_id, base_ref, project_id, attempt_id, workflow_protocol,
         verifier_protocol, candidate_tree_oid, dispatched_at, dispatch_nonce,
         workflow_commit_sha, workflow_blob_sha, workflow_content_digest,
         required_suites, policy_digest, pull_request_number, base_sha, candidate_sha
       ) SELECT ?, ?, ?, ?, 2, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM queue_projects q
             JOIN projects p ON p.id = q.project_id
             JOIN organizations o ON o.id = p.organization_id
            WHERE q.github_repository_id = ? AND q.base_ref = ?
              AND q.project_id = ? AND q.verifier_protocol = 3
              AND q.enabled = 1 AND o.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM project_release_requests r
                 WHERE r.github_repository_id = q.github_repository_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_release_jobs j
                 WHERE j.github_repository_id = q.github_repository_id
              )
          )
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid)
       DO UPDATE SET dispatched_at = excluded.dispatched_at,
                     attempt_id = excluded.attempt_id,
                     verifier_protocol = 3,
                     dispatch_nonce = excluded.dispatch_nonce,
                     workflow_commit_sha = excluded.workflow_commit_sha,
                     workflow_blob_sha = excluded.workflow_blob_sha,
                     workflow_content_digest = excluded.workflow_content_digest,
                     required_suites = excluded.required_suites,
                     policy_digest = excluded.policy_digest,
                     pull_request_number = excluded.pull_request_number,
                     base_sha = excluded.base_sha,
                     candidate_sha = excluded.candidate_sha,
                     report_run_id = NULL,
                     report_run_attempt = NULL,
                     report_check_run_id = NULL,
                     report_jti = NULL,
                     pending_at = NULL,
                     finalize_after = NULL,
                     finalized_at = NULL,
                     terminal_reason = NULL,
                     finalizer_claim = NULL,
                     finalizer_claim_expires_at = NULL
        WHERE candidate_dispatches.project_id = excluded.project_id
          AND (candidate_dispatches.pending_at IS NULL
            OR candidate_dispatches.terminal_reason IS NOT NULL)`,
    )
    .bind(
      dispatch.repositoryId,
      dispatch.baseRef,
      dispatch.projectId,
      dispatch.attemptId,
      dispatch.candidateTreeOid,
      at,
      dispatch.dispatchNonce,
      dispatch.workflowCommitSha,
      dispatch.workflowBlobSha,
      dispatch.workflowContentDigest,
      JSON.stringify(dispatch.requiredSuites),
      dispatch.policyDigest,
      dispatch.pullRequestNumber,
      dispatch.baseSha,
      dispatch.candidateSha,
      dispatch.repositoryId,
      dispatch.baseRef,
      dispatch.projectId,
    )
    .run();
  return ((written as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

export interface PendingCandidateReport extends CandidateDispatchV3 {
  readonly runId: string;
  readonly runAttempt: number;
  readonly checkRunId: string;
  readonly jti: string;
  readonly pendingAt: string;
}

/** Store identity only. Candidate-provided result content is never accepted. */
export async function registerCandidateReport(
  db: D1Like,
  repositoryId: string,
  dispatchNonce: string,
  identity: { runId: string; runAttempt: number; checkRunId: string; jti: string },
  at: string,
): Promise<"registered" | "duplicate" | "unavailable"> {
  if (!(await verifierProtocolV3Ready(db))) return "unavailable";
  const result = await db
    .prepare(
      `UPDATE candidate_dispatches
          SET report_run_id = ?, report_run_attempt = ?, report_check_run_id = ?,
              report_jti = ?, pending_at = ?, finalize_after = ?
        WHERE github_repository_id = ? AND dispatch_nonce = ?
          AND verifier_protocol = 3 AND pending_at IS NULL
          AND terminal_reason IS NULL AND finalized_at IS NULL
          AND EXISTS (
            SELECT 1 FROM queue_projects q
             JOIN projects p ON p.id = q.project_id
             JOIN organizations o ON o.id = p.organization_id
            WHERE q.github_repository_id = candidate_dispatches.github_repository_id
              AND q.base_ref = candidate_dispatches.base_ref
              AND q.project_id = candidate_dispatches.project_id
              AND q.verifier_protocol = 3 AND q.enabled = 1 AND o.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM project_release_requests r
                 WHERE r.github_repository_id = q.github_repository_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_release_jobs j
                 WHERE j.github_repository_id = q.github_repository_id
              )
          )`,
    )
    .bind(
      identity.runId,
      identity.runAttempt,
      identity.checkRunId,
      identity.jti,
      at,
      at,
      repositoryId,
      dispatchNonce,
    )
    .run();
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1) return "registered";
  const existing = await db
    .prepare(
      `SELECT report_run_id AS runId, report_run_attempt AS runAttempt,
              report_check_run_id AS checkRunId, report_jti AS jti
         FROM candidate_dispatches
        WHERE github_repository_id = ? AND dispatch_nonce = ?
          AND verifier_protocol = 3`,
    )
    .bind(repositoryId, dispatchNonce)
    .first<{ runId: string | null; runAttempt: number | null; checkRunId: string | null; jti: string | null }>();
  return existing !== null &&
    existing.runId === identity.runId &&
    existing.runAttempt === identity.runAttempt &&
    existing.checkRunId === identity.checkRunId &&
    existing.jti === identity.jti
    ? "duplicate"
    : "unavailable";
}

export async function candidateDispatchV3ByNonce(
  db: D1Like,
  repositoryId: string,
  dispatchNonce: string,
): Promise<CandidateDispatchV3 | null> {
  if (!(await verifierProtocolV3Ready(db))) return null;
  const row = await db
    .prepare(
      `SELECT github_repository_id AS repositoryId, base_ref AS baseRef,
              project_id AS projectId, attempt_id AS attemptId,
              candidate_tree_oid AS candidateTreeOid, candidate_sha AS candidateSha,
              base_sha AS baseSha, pull_request_number AS pullRequestNumber,
              required_suites AS requiredSuites, dispatch_nonce AS dispatchNonce,
              policy_digest AS policyDigest,
              workflow_commit_sha AS workflowCommitSha, workflow_blob_sha AS workflowBlobSha,
              workflow_content_digest AS workflowContentDigest
         FROM candidate_dispatches
        WHERE github_repository_id = ? AND dispatch_nonce = ?
          AND verifier_protocol = 3`,
    )
    .bind(repositoryId, dispatchNonce)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  try {
    const requiredSuites = JSON.parse(String(row["requiredSuites"]));
    if (!validStoredDispatch(row, requiredSuites)) return null;
    return { ...(row as unknown as Omit<CandidateDispatchV3, "requiredSuites">), requiredSuites };
  } catch {
    return null;
  }
}

export interface PendingCandidateFinalization extends CandidateDispatchV3 {
  readonly runId: string;
  readonly runAttempt: number;
  readonly checkRunId: string;
  readonly pendingAt: string;
}

/** Fair, bounded claim. An expired claim may be taken over after a dead tick. */
export async function claimPendingCandidateReports(
  db: D1Like,
  claim: string,
  now: string,
  expiresAt: string,
  limit: number,
): Promise<readonly PendingCandidateFinalization[]> {
  if (!(await verifierProtocolV3Ready(db))) return [];
  const rows = await db
    .prepare(
      `SELECT github_repository_id AS repositoryId, base_ref AS baseRef,
              project_id AS projectId, attempt_id AS attemptId,
              candidate_tree_oid AS candidateTreeOid, candidate_sha AS candidateSha,
              base_sha AS baseSha, pull_request_number AS pullRequestNumber,
              required_suites AS requiredSuites, dispatch_nonce AS dispatchNonce,
              policy_digest AS policyDigest,
              workflow_commit_sha AS workflowCommitSha, workflow_blob_sha AS workflowBlobSha,
              workflow_content_digest AS workflowContentDigest,
              report_run_id AS runId, report_run_attempt AS runAttempt,
              report_check_run_id AS checkRunId, pending_at AS pendingAt
         FROM candidate_dispatches
        WHERE verifier_protocol = 3 AND pending_at IS NOT NULL
          AND finalized_at IS NULL AND terminal_reason IS NULL
          AND finalize_after <= ?
          AND (finalizer_claim IS NULL OR finalizer_claim_expires_at <= ?)
        ORDER BY finalize_after, dispatched_at, github_repository_id
        LIMIT ?`,
    )
    .bind(now, now, Math.max(1, Math.min(limit, 20)))
    .all<Record<string, unknown>>();
  const claimed: PendingCandidateFinalization[] = [];
  for (const row of rows.results) {
    const update = await db
      .prepare(
        `UPDATE candidate_dispatches
            SET finalizer_claim = ?, finalizer_claim_expires_at = ?
          WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
            AND project_id = ? AND verifier_protocol = 3
            AND finalized_at IS NULL AND terminal_reason IS NULL
            AND (finalizer_claim IS NULL OR finalizer_claim_expires_at <= ?)`,
      )
      .bind(
        claim,
        expiresAt,
        row["repositoryId"],
        row["baseRef"],
        row["candidateTreeOid"],
        row["projectId"],
        now,
      )
      .run();
    if (((update as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
    try {
      const requiredSuites = JSON.parse(String(row["requiredSuites"]));
      if (
        !validStoredDispatch(row, requiredSuites) ||
        typeof row["runId"] !== "string" || !/^\d+$/.test(row["runId"]) ||
        typeof row["runAttempt"] !== "number" || !Number.isSafeInteger(row["runAttempt"]) ||
        row["runAttempt"] < 1 || typeof row["checkRunId"] !== "string" || !/^\d+$/.test(row["checkRunId"]) ||
        typeof row["pendingAt"] !== "string" || !Number.isFinite(Date.parse(row["pendingAt"]))
      ) continue;
      claimed.push({
        ...(row as unknown as Omit<PendingCandidateFinalization, "requiredSuites">),
        requiredSuites,
      });
    } catch {
      // The finalizer marks malformed rows terminal through the caller.
    }
  }
  return claimed;
}

export async function retryPendingCandidateReport(
  db: D1Like,
  row: PendingCandidateFinalization,
  claim: string,
  after: string,
): Promise<void> {
  if (!(await verifierProtocolV3Ready(db))) return;
  await db
    .prepare(
      `UPDATE candidate_dispatches
          SET finalize_after = ?, finalizer_claim = NULL, finalizer_claim_expires_at = NULL
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ? AND finalizer_claim = ? AND terminal_reason IS NULL
          AND finalized_at IS NULL`,
    )
    .bind(after, row.repositoryId, row.baseRef, row.candidateTreeOid, row.projectId, claim)
    .run();
}

export async function finishPendingCandidateReport(
  db: D1Like,
  row: PendingCandidateFinalization,
  claim: string,
  outcome: { finalizedAt: string } | { terminalReason: string },
): Promise<boolean> {
  if (!(await verifierProtocolV3Ready(db))) return false;
  const result = await db
    .prepare(
      `UPDATE candidate_dispatches
          SET finalized_at = ?, terminal_reason = ?,
              finalizer_claim = NULL, finalizer_claim_expires_at = NULL
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ? AND finalizer_claim = ?
          AND finalized_at IS NULL AND terminal_reason IS NULL`,
    )
    .bind(
      "finalizedAt" in outcome ? outcome.finalizedAt : null,
      "terminalReason" in outcome ? outcome.terminalReason : null,
      row.repositoryId,
      row.baseRef,
      row.candidateTreeOid,
      row.projectId,
      claim,
    )
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/**
 * Materialize one v3 verdict and consume its finalizer claim atomically.
 *
 * The insert is authorized by the exact claimed dispatch and live project
 * incarnation. The paired update only succeeds when that exact v3 verdict is
 * present. D1 batches are transactional, so neither half can become durable
 * without the other.
 */
export async function finalizeCandidateVerdictV3(
  db: D1Like,
  row: PendingCandidateFinalization,
  claim: string,
  verdict: CandidateVerdict,
  finalizedAt: string,
): Promise<boolean> {
  if (!(await verifierProtocolV3Ready(db))) return false;
  if (
    verdict.candidateTreeOid !== row.candidateTreeOid ||
    verdict.candidateSha !== row.candidateSha ||
    verdict.baseSha !== row.baseSha ||
    verdict.pullRequestNumber !== row.pullRequestNumber ||
    verdict.workflowSha !== row.workflowCommitSha ||
    verdict.runId !== row.runId ||
    verdict.policyDigest !== row.policyDigest
  ) {
    return false;
  }
  const insert = db
    .prepare(
      `INSERT INTO candidate_verdicts (
         github_repository_id, base_ref, project_id, candidate_tree_oid, candidate_sha, base_sha,
         pull_request_number, accepted, result_digest, policy_digest, suites,
         reason_codes, workflow_ref, workflow_sha, run_id, observed_at, verifier_protocol
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3
          WHERE EXISTS (
            SELECT 1 FROM candidate_dispatches d
             JOIN queue_projects q
               ON q.github_repository_id = d.github_repository_id
              AND q.base_ref = d.base_ref AND q.project_id = d.project_id
             JOIN projects p ON p.id = q.project_id
             JOIN organizations o ON o.id = p.organization_id
            WHERE d.github_repository_id = ? AND d.base_ref = ?
              AND d.candidate_tree_oid = ? AND d.project_id = ?
              AND d.dispatch_nonce = ? AND d.finalizer_claim = ?
              AND d.verifier_protocol = 3 AND d.finalized_at IS NULL
              AND d.terminal_reason IS NULL AND q.verifier_protocol = 3
              AND q.enabled = 1 AND o.status = 'active'
              AND p.active_policy_digest = d.policy_digest
              AND EXISTS (
                SELECT 1 FROM queue_state s
                 WHERE s.github_repository_id = d.github_repository_id
                   AND s.base_ref = d.base_ref AND s.project_id = d.project_id
                   AND json_extract(s.document, '$.state.activeAttemptId') = d.attempt_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_release_requests r
                 WHERE r.github_repository_id = q.github_repository_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_release_jobs j
                 WHERE j.github_repository_id = q.github_repository_id
              )
          )
       ON CONFLICT (github_repository_id, base_ref, candidate_tree_oid) DO NOTHING`,
    )
    .bind(
      row.repositoryId,
      row.baseRef,
      row.projectId,
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
      row.repositoryId,
      row.baseRef,
      row.candidateTreeOid,
      row.projectId,
      row.dispatchNonce,
      claim,
    );
  const finish = db
    .prepare(
      `UPDATE candidate_dispatches
          SET finalized_at = ?, finalizer_claim = NULL,
              finalizer_claim_expires_at = NULL
        WHERE github_repository_id = ? AND base_ref = ? AND candidate_tree_oid = ?
          AND project_id = ? AND dispatch_nonce = ? AND finalizer_claim = ?
          AND verifier_protocol = 3 AND finalized_at IS NULL AND terminal_reason IS NULL
          AND EXISTS (
            SELECT 1 FROM candidate_verdicts v
             WHERE v.github_repository_id = candidate_dispatches.github_repository_id
               AND v.base_ref = candidate_dispatches.base_ref
               AND v.candidate_tree_oid = candidate_dispatches.candidate_tree_oid
               AND v.project_id = candidate_dispatches.project_id
               AND v.verifier_protocol = 3 AND v.result_digest = ?
          )`,
    )
    .bind(
      finalizedAt,
      row.repositoryId,
      row.baseRef,
      row.candidateTreeOid,
      row.projectId,
      row.dispatchNonce,
      claim,
      verdict.resultDigest,
    );
  await db.batch([insert, finish]);
  const complete = await db
    .prepare(
      `SELECT 1 AS present FROM candidate_dispatches d
        JOIN candidate_verdicts v
          ON v.github_repository_id = d.github_repository_id AND v.base_ref = d.base_ref
         AND v.candidate_tree_oid = d.candidate_tree_oid AND v.project_id = d.project_id
       WHERE d.github_repository_id = ? AND d.base_ref = ? AND d.candidate_tree_oid = ?
         AND d.project_id = ? AND d.dispatch_nonce = ? AND d.verifier_protocol = 3
         AND d.finalized_at = ? AND d.terminal_reason IS NULL
         AND v.verifier_protocol = 3 AND v.result_digest = ?`,
    )
    .bind(
      row.repositoryId,
      row.baseRef,
      row.candidateTreeOid,
      row.projectId,
      row.dispatchNonce,
      finalizedAt,
      verdict.resultDigest,
    )
    .first<{ present: number }>();
  return complete !== null;
}
