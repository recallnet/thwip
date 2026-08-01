import type { D1Like } from "./projection.js";

/**
 * Copy signed records out of D1 into content-addressed storage.
 *
 * Every record written before the mirror existed lives in exactly one place, and
 * the queue document that references it is compacted. Safe to run repeatedly:
 * it asks what the bucket already holds and writes only the difference, so it is
 * run from the daily cron until it reports nothing left.
 *
 * The query reads only rows with no `mirrored_at`, which the loop stamps on a
 * successful copy and on finding the bucket already holds one. Without that
 * watermark the query has no cursor, re-reads the same oldest page every run,
 * and a backlog bigger than one page never drains — this table's entire
 * purpose. A row skipped because its repository has no organization is left
 * unstamped on purpose: no durable copy exists yet, so it must come back on
 * the next run.
 */
export interface BackfillPorts {
  organizationIdFor(repositoryId: string): Promise<string | null>;
  has(input: { organizationId: string; repositoryId: string; kind: string; digest: string }): Promise<boolean>;
  put(input: {
    organizationId: string;
    repositoryId: string;
    kind: "merge-intent" | "transition-record";
    digest: string;
    bytes: Uint8Array;
  }): Promise<void>;
}

export async function backfillAttestations(
  db: D1Like,
  ports: BackfillPorts,
  limit = 200,
): Promise<{ copied: number; alreadyThere: number; skipped: number }> {
  const rows = await db
    .prepare(
      `SELECT digest, kind, github_repository_id AS repositoryId, bytes
         FROM queue_attestations
        WHERE mirrored_at IS NULL
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ digest: string; kind: string; repositoryId: string; bytes: string }>();

  const encoder = new TextEncoder();
  let copied = 0;
  let alreadyThere = 0;
  let skipped = 0;

  for (const row of rows.results) {
    const organizationId = await ports.organizationIdFor(row.repositoryId);
    if (organizationId === null) {
      // No tenant to scope the object under. Recording it anywhere else would
      // put one customer's evidence outside their own prefix. Nothing was
      // written, so the row keeps mirrored_at NULL and is picked up again
      // once the repository has an organization.
      skipped += 1;
      continue;
    }
    const kind = row.kind === "merge-intent" ? "merge-intent" : "transition-record";
    if (await ports.has({ organizationId, repositoryId: row.repositoryId, kind, digest: row.digest })) {
      await stampMirrored(db, row.digest);
      alreadyThere += 1;
      continue;
    }
    await ports.put({
      organizationId,
      repositoryId: row.repositoryId,
      kind,
      digest: row.digest,
      bytes: encoder.encode(row.bytes),
    });
    await stampMirrored(db, row.digest);
    copied += 1;
  }

  return { copied, alreadyThere, skipped };
}

/**
 * Mark a row as having a durable copy, so the next run's WHERE clause skips
 * it instead of reconsidering it forever.
 */
async function stampMirrored(db: D1Like, digest: string): Promise<void> {
  await db
    .prepare(`UPDATE queue_attestations SET mirrored_at = ? WHERE digest = ?`)
    .bind(new Date().toISOString(), digest)
    .run();
}
