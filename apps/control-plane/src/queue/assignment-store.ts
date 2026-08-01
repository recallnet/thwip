import type { D1Like } from "./projection.js";
import type { SubmittedReceiptSuite } from "./integration-receipt.js";

/**
 * The assignments this queue handed to a device, and the receipts it accepted
 * back (migration 0021).
 *
 * Under `fresh` and `audited` the suites run on the developer's machine, so the
 * merge gate has no evidence to weigh unless the dispatch and the answer are
 * durable. Everything the gate compares lives in one row: the tree the device
 * was told to run, the device that was told to run it, and the receipt that
 * came back. A gate reading two tables could find one half and act on it.
 *
 * Neither write trusts the caller to have checked first. Issuing a second
 * assignment for an attempt loses to the unique index rather than replacing the
 * first, and accepting a receipt matches on `receipt_digest IS NULL`, so a
 * second receipt for the same assignment changes nothing.
 */

export interface IssuedAssignmentRecord {
  readonly assignmentId: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly attemptId: string;
  readonly assignmentDigest: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly principalId: string;
  readonly deviceKeyId: string;
  readonly requiredSuites: readonly string[];
  readonly executionSeconds: number;
  readonly issuedAt: string;
}

export interface AcceptedReceiptRecord {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly receiptDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly assignmentDigest: string;
  readonly suites: readonly SubmittedReceiptSuite[];
  readonly acceptedAt: string;
}

export interface StoredAssignment extends IssuedAssignmentRecord {
  /** Null until a receipt has been accepted for it. */
  readonly receipt: AcceptedReceiptRecord | null;
}

interface AssignmentRow {
  assignment_id: string;
  github_repository_id: string;
  base_ref: string;
  attempt_id: string;
  assignment_digest: string;
  candidate_sha: string;
  candidate_tree_oid: string;
  principal_id: string;
  device_key_id: string;
  required_suites: string;
  execution_seconds: number;
  issued_at: string;
  receipt_digest: string | null;
  receipt_suites: string | null;
  receipt_accepted_at: string | null;
}

const COLUMNS = `assignment_id, github_repository_id, base_ref, attempt_id, assignment_digest,
                 candidate_sha, candidate_tree_oid, principal_id, device_key_id, required_suites,
                 execution_seconds, issued_at, receipt_digest, receipt_suites, receipt_accepted_at`;

function fromRow(row: AssignmentRow): StoredAssignment {
  const receipt: AcceptedReceiptRecord | null =
    row.receipt_digest === null || row.receipt_accepted_at === null
      ? null
      : {
          assignmentId: row.assignment_id,
          attemptId: row.attempt_id,
          receiptDigest: row.receipt_digest,
          candidateTreeOid: row.candidate_tree_oid,
          deviceKeyId: row.device_key_id,
          assignmentDigest: row.assignment_digest,
          suites: JSON.parse(row.receipt_suites ?? "[]") as SubmittedReceiptSuite[],
          acceptedAt: row.receipt_accepted_at,
        };
  return {
    assignmentId: row.assignment_id,
    repositoryId: row.github_repository_id,
    baseRef: row.base_ref,
    attemptId: row.attempt_id,
    assignmentDigest: row.assignment_digest,
    candidateSha: row.candidate_sha,
    candidateTreeOid: row.candidate_tree_oid,
    principalId: row.principal_id,
    deviceKeyId: row.device_key_id,
    requiredSuites: JSON.parse(row.required_suites) as string[],
    executionSeconds: row.execution_seconds,
    issuedAt: row.issued_at,
    receipt,
  };
}

/**
 * Write down an assignment that has just been issued.
 *
 * `duplicate` means this attempt already had one, and the caller must use that
 * one rather than the one it just built: two devices racing the same offer both
 * reach here, and letting the second overwrite would leave the queue holding an
 * assignment for a device the reducer never let claim the offer.
 */
export async function recordIssuedAssignment(
  db: D1Like,
  record: IssuedAssignmentRecord,
): Promise<{ status: "applied" } | { status: "duplicate"; held: StoredAssignment }> {
  const held = await issuedAssignmentForAttempt(db, record.attemptId);
  if (held !== null) return { status: "duplicate", held };

  try {
    await db
      .prepare(
        `INSERT INTO queue_assignments (
           assignment_id, github_repository_id, base_ref, attempt_id, assignment_digest,
           candidate_sha, candidate_tree_oid, principal_id, device_key_id, required_suites,
           execution_seconds, issued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.assignmentId,
        record.repositoryId,
        record.baseRef,
        record.attemptId,
        record.assignmentDigest,
        record.candidateSha,
        record.candidateTreeOid,
        record.principalId,
        record.deviceKeyId,
        JSON.stringify([...record.requiredSuites]),
        record.executionSeconds,
        record.issuedAt,
      )
      .run();
    return { status: "applied" };
  } catch (error) {
    // The read above narrows the race, the unique index closes it. A loser
    // reports the winner rather than throwing, because losing a race is not
    // this caller's error.
    const winner = await issuedAssignmentForAttempt(db, record.attemptId);
    if (winner === null) throw error;
    return { status: "duplicate", held: winner };
  }
}

export async function issuedAssignment(db: D1Like, assignmentId: string): Promise<StoredAssignment | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM queue_assignments WHERE assignment_id = ?`)
    .bind(assignmentId)
    .first<AssignmentRow>();
  return row === null ? null : fromRow(row);
}

export async function issuedAssignmentForAttempt(db: D1Like, attemptId: string): Promise<StoredAssignment | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM queue_assignments WHERE attempt_id = ?`)
    .bind(attemptId)
    .first<AssignmentRow>();
  return row === null ? null : fromRow(row);
}

/**
 * Record that a receipt was accepted for an assignment.
 *
 * `duplicate` means one was already accepted, and it stands. A later receipt
 * asks the queue to change what it will merge on, after the gate may already
 * have read the first, so it is refused rather than obeyed — the same rule the
 * reducer applies to a verdict that arrives too late.
 */
export async function recordAcceptedReceipt(
  db: D1Like,
  input: {
    readonly assignmentId: string;
    readonly receiptDigest: string;
    readonly suites: readonly SubmittedReceiptSuite[];
    readonly acceptedAt: string;
  },
): Promise<{ status: "applied" | "duplicate" | "unknown-assignment" }> {
  const existing = await issuedAssignment(db, input.assignmentId);
  if (existing === null) return { status: "unknown-assignment" };
  if (existing.receipt !== null) return { status: "duplicate" };

  await db
    .prepare(
      `UPDATE queue_assignments
          SET receipt_digest = ?, receipt_suites = ?, receipt_accepted_at = ?
        WHERE assignment_id = ? AND receipt_digest IS NULL`,
    )
    .bind(input.receiptDigest, JSON.stringify([...input.suites]), input.acceptedAt, input.assignmentId)
    .run();

  const after = await issuedAssignment(db, input.assignmentId);
  return { status: after?.receipt?.receiptDigest === input.receiptDigest ? "applied" : "duplicate" };
}

/** The accepted receipt for an attempt, or null while there is none. */
export async function acceptedReceiptFor(db: D1Like, attemptId: string): Promise<AcceptedReceiptRecord | null> {
  const stored = await issuedAssignmentForAttempt(db, attemptId);
  return stored?.receipt ?? null;
}
