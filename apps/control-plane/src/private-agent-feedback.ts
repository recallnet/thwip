import type { D1Like } from "./queue/projection.js";
import { databaseSchemaCapabilities } from "./schema-state.js";

const RETENTION_LOOKAHEAD_MS = 5 * 60_000;
const RETENTION_CLAIM_MS = 4 * 60_000;
const RETENTION_INTERVAL_MS = 4 * 60_000 + 30_000;
const DEFAULT_SWEEP_LIMIT = 100;

export interface PrivateFeedbackRetentionResult {
  readonly skipped: boolean;
  readonly privateRootsDeleted: number;
  readonly receiptsDeleted: number;
}

interface RunResult {
  readonly meta?: { readonly changes?: number };
}

function changes(result: unknown): number {
  return (result as RunResult).meta?.changes ?? 0;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Delete report-derived content before the next five-minute wake-up, while
 * enforcing the 90-day hard-read deadline even if deletion is delayed.
 */
export async function runPrivateFeedbackRetention(
  db: D1Like,
  now = new Date(),
  limit = DEFAULT_SWEEP_LIMIT,
): Promise<PrivateFeedbackRetentionResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid retention sweep limit");
  // The #398 maintenance generation deliberately runs the new Worker against
  // the schema immediately before 0031/0032. Feedback is still dark there, so
  // there is no content to retain and no safe table to claim yet.
  if (!(await databaseSchemaCapabilities(db)).privateAgentFeedback) {
    return { skipped: true, privateRootsDeleted: 0, receiptsDeleted: 0 };
  }
  const token = randomId("afc");
  const startedAt = now.toISOString();
  const deleteBefore = new Date(now.getTime() + RETENTION_LOOKAHEAD_MS).toISOString();
  const claimExpiresAt = new Date(now.getTime() + RETENTION_CLAIM_MS).toISOString();
  const notStartedAfter = new Date(now.getTime() - RETENTION_INTERVAL_MS).toISOString();
  const claim = await db.prepare(
    `UPDATE agent_report_retention_clock
        SET claim_token = ?, claim_expires_at = ?, last_started_at = ?, last_error = NULL
      WHERE id = 1
        AND (claim_token IS NULL OR claim_expires_at <= ?)
        AND (last_started_at IS NULL OR last_started_at <= ?)`,
  ).bind(token, claimExpiresAt, startedAt, startedAt, notStartedAfter).run();
  if (changes(claim) !== 1) {
    return { skipped: true, privateRootsDeleted: 0, receiptsDeleted: 0 };
  }

  try {
    const roots = await db.prepare(
      `SELECT id, receipt_id AS receiptId
         FROM agent_report_private_roots
        WHERE delete_at <= ?
        ORDER BY delete_at, id
        LIMIT ?`,
    ).bind(deleteBefore, limit).all<{ id: string; receiptId: string }>();
    let privateRootsDeleted = 0;
    if (roots.results.length > 0) {
      const rootIds = roots.results.map((row) => row.id);
      const receiptIds = roots.results.map((row) => row.receiptId);
      const rootSlots = rootIds.map(() => "?").join(", ");
      const receiptSlots = receiptIds.map(() => "?").join(", ");
      const deletedAt = now.toISOString();
      await db.batch([
        db.prepare(
          `UPDATE agent_report_receipts
              SET status = CASE
                    WHEN status IN ('awaiting_approval', 'submitted') THEN 'closed'
                    ELSE status
                  END,
                  final_at = CASE
                    WHEN status IN ('awaiting_approval', 'submitted') THEN COALESCE(final_at, ?)
                    ELSE final_at
                  END,
                  content_deleted_at = COALESCE(content_deleted_at, ?), updated_at = ?
            WHERE id IN (${receiptSlots})`,
        ).bind(deletedAt, deletedAt, deletedAt, ...receiptIds),
        db.prepare(`DELETE FROM agent_report_private_roots WHERE id IN (${rootSlots})`).bind(...rootIds),
      ]);
      privateRootsDeleted = roots.results.length;
    }

    const receiptDeletion = await db.prepare(
      `DELETE FROM agent_report_receipts
        WHERE id IN (
          SELECT id FROM agent_report_receipts
           WHERE expires_at <= ?
           ORDER BY expires_at, id
           LIMIT ?
        )`,
    ).bind(startedAt, limit).run();
    const receiptsDeleted = changes(receiptDeletion);

    const overdue = await db.prepare(
      `SELECT
         (SELECT count(*) FROM agent_report_private_roots WHERE delete_at <= ?) +
         (SELECT count(*) FROM agent_report_receipts WHERE expires_at <= ?) AS count`,
    ).bind(startedAt, startedAt).first<{ count: number }>();
    if ((overdue?.count ?? 0) > 0) throw new Error("private feedback retention is overdue");

    await db.prepare(
      `UPDATE agent_report_retention_clock
          SET claim_token = NULL, claim_expires_at = NULL, last_finished_at = ?,
              last_error_at = NULL, last_error = NULL
        WHERE id = 1 AND claim_token = ?`,
    ).bind(new Date().toISOString(), token).run();
    return { skipped: false, privateRootsDeleted, receiptsDeleted };
  } catch (error) {
    await db.prepare(
      `UPDATE agent_report_retention_clock
          SET claim_token = NULL, claim_expires_at = NULL, last_error_at = ?,
              last_error = 'private feedback retention failed'
        WHERE id = 1 AND claim_token = ?`,
    ).bind(new Date().toISOString(), token).run();
    throw error;
  }
}
