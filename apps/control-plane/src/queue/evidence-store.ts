import { canonicalRecordBytes, envelopeDigest, type Sha256 } from "@thwip/queue-protocol";
import type { DecisionRecorder } from "./commands.js";
import type { D1Like } from "./projection.js";

/**
 * Digest-addressed evidence storage.
 *
 * Signed evidence is immutable and named by the digest of its own bytes, which
 * gives two properties worth having. A reader can verify what they fetched
 * without trusting the store, because the key is the hash of the content. And a
 * write can never corrupt existing evidence, because a second write to the same
 * key is either identical or a detected conflict — there is no version to
 * overwrite.
 *
 * The store never holds source, logs, or secrets. It holds signed envelopes,
 * whose contents the protocol already bounds.
 */

export interface R2Like {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
}

const R2_WRITE_INTENT_LIFETIME_MS = 15 * 60_000;
const R2_WRITE_INTENT_HEARTBEAT_MS = 60_000;

export interface R2WriteIntentLease {
  readonly key: string;
  readonly projectId: string;
  /** Keep a live external write from being mistaken for terminated work. */
  renew(): Promise<void>;
  /** Leave durable cleanup work before an uncertain or stale write is deleted. */
  markCleanup(): Promise<void>;
  /** Clear the intent only after the object is known to be valid or absent. */
  complete(): Promise<void>;
  /** Mark cleanup, delete the exact key, confirm absence, then clear the intent. */
  compensate(bucket: Pick<R2Like, "delete" | "head">): Promise<void>;
}

/**
 * Persist exact-project cleanup authority immediately before an R2 put.
 *
 * The row deliberately survives project deletion. If this invocation ends
 * after R2 accepts the write but before the project postcheck, the release
 * drainer can still remove this exact old-project object.
 */
export async function beginR2WriteIntent(
  db: D1Like,
  input: {
    readonly key: string;
    readonly projectId: string;
    readonly organizationId: string;
    readonly repositoryId: string;
  },
): Promise<R2WriteIntentLease | null> {
  const owner = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + R2_WRITE_INTENT_LIFETIME_MS).toISOString();
  const generation = await db.prepare(
    "SELECT generation FROM project_r2_capability_generations WHERE state = 'active' LIMIT 1",
  ).bind().first<{ generation: string }>();
  if (generation === null) return null;
  const inserted = await db.prepare(
    `INSERT INTO project_r2_cleanup_intents
       (object_key, project_id, organization_id, github_repository_id,
        capability_generation, state, owner_token, lease_expires_at)
     SELECT ?, p.id, p.organization_id, p.github_repository_id, ?, 'writing', ?, ?
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = ? AND p.organization_id = ? AND p.github_repository_id = ?
        AND o.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM project_release_requests r
           WHERE r.github_repository_id = p.github_repository_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs j
           WHERE j.github_repository_id = p.github_repository_id
        )
     ON CONFLICT(object_key) DO NOTHING`,
  ).bind(
    input.key,
    generation.generation,
    owner,
    expiresAt,
    input.projectId,
    input.organizationId,
    input.repositoryId,
  ).run();
  if (((inserted as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return null;

  let stopped = false;
  let renewalFailure: Error | null = null;
  const updateOwned = async (sql: string, ...bindings: unknown[]): Promise<boolean> => {
    const result = await db.prepare(sql).bind(...bindings, input.key, input.projectId, owner).run();
    return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
  };
  const renew = async () => {
    if (renewalFailure !== null) throw renewalFailure;
    if (!(await updateOwned(
      `UPDATE project_r2_cleanup_intents SET lease_expires_at = ?
        WHERE object_key = ? AND project_id = ? AND owner_token = ? AND state = 'writing'`,
      new Date(Date.now() + R2_WRITE_INTENT_LIFETIME_MS).toISOString(),
    ))) {
      renewalFailure = new Error(`R2 write intent for ${input.key} lost ownership`);
      throw renewalFailure;
    }
  };
  const heartbeat = setInterval(() => {
    void renew().catch((error: unknown) => {
      renewalFailure = error instanceof Error ? error : new Error(String(error));
    });
  }, R2_WRITE_INTENT_HEARTBEAT_MS);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
  };
  const complete = async () => {
    stop();
    // If a drainer already took this expired lease, leave its durable row in
    // place. It will either preserve a current-project object or delete an old
    // one after its own exact-project check.
    await updateOwned(
      `DELETE FROM project_r2_cleanup_intents
        WHERE object_key = ? AND project_id = ? AND owner_token = ?`,
    );
  };
  const markCleanup = async () => {
    stop();
    const attemptedAt = new Date().toISOString();
    if (await updateOwned(
      `UPDATE project_r2_cleanup_intents
          SET state = 'cleanup', lease_expires_at = ?, last_attempted_at = ?
        WHERE object_key = ? AND project_id = ? AND owner_token = ?`,
      new Date(0).toISOString(),
      attemptedAt,
    )) return;
    // A late put can resume after a drainer has cleared the expired intent.
    // Restore durable cleanup before attempting compensation. If another
    // drainer still owns the row, that row already provides the obligation.
    await db.prepare(
      `INSERT INTO project_r2_cleanup_intents
         (object_key, project_id, organization_id, github_repository_id,
          capability_generation, state, owner_token, lease_expires_at, last_attempted_at)
       VALUES (?, ?, ?, ?, ?, 'cleanup', ?, ?, ?)
       ON CONFLICT(object_key) DO NOTHING`,
    ).bind(
      input.key,
      input.projectId,
      input.organizationId,
      input.repositoryId,
      generation.generation,
      owner,
      new Date(0).toISOString(),
      attemptedAt,
    ).run();
  };
  return {
    key: input.key,
    projectId: input.projectId,
    renew,
    markCleanup,
    complete,
    async compensate(bucket) {
      await markCleanup();
      try {
        await bucket.delete(input.key);
        if (await bucket.head(input.key) !== null) {
          throw new Error(`R2 compensation did not remove ${input.key}`);
        }
      } catch (error) {
        // Ensure a drainer still has an obligation if ownership changed while
        // this external delete was running.
        await markCleanup().catch(() => {});
        throw error;
      }
      await complete();
    },
  };
}

export type EvidenceKind =
  | "queue-decision"
  | "integration-assignment"
  | "integration-receipt"
  | "verifier-result"
  | "merge-intent"
  | "transition-record";

/**
 * The key layout. Tenant-scoped so an export or a deletion can be bounded to one
 * repository, and digest-suffixed so the content is self-verifying.
 */
export function evidenceKey(input: {
  readonly projectId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly kind: EvidenceKind;
  readonly digest: Sha256;
}): string {
  const hex = input.digest.slice("sha256:".length);
  // Two-level fan-out on the digest keeps any single prefix from growing without
  // bound, which matters for listing and lifecycle rules.
  return `project/${input.projectId}/org/${input.organizationId}/repo/${input.repositoryId}/${input.kind}/${hex.slice(0, 2)}/${hex}`;
}

function legacyEvidenceKey(input: {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly kind: EvidenceKind;
  readonly digest: Sha256;
}): string {
  const hex = input.digest.slice("sha256:".length);
  return `org/${input.organizationId}/repo/${input.repositoryId}/${input.kind}/${hex.slice(0, 2)}/${hex}`;
}

export type PutResult =
  | { readonly stored: true; readonly key: string; readonly deduplicated: boolean }
  | { readonly stored: false; readonly reason: "DIGEST_MISMATCH"; readonly expected: Sha256; readonly actual: Sha256 }
  | { readonly stored: false; readonly reason: "CONTENT_CONFLICT"; readonly key: string };

async function digestOf(bytes: Uint8Array): Promise<Sha256> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Store one signed envelope. The digest is recomputed from the bytes rather than
 * trusted, because a caller that passed a mismatched pair would create evidence
 * whose name lies about its content — and every later reader would verify the
 * wrong thing.
 */
export async function putEvidence(
  bucket: R2Like,
  input: {
    readonly projectId: string;
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly kind: EvidenceKind;
    readonly digest: Sha256;
    readonly bytes: Uint8Array;
    readonly attemptId?: string;
  },
  hooks: { readonly beforePut?: (key: string) => Promise<void> } = {},
): Promise<PutResult> {
  const actual = await digestOf(input.bytes);
  if (actual !== input.digest) {
    return { stored: false, reason: "DIGEST_MISMATCH", expected: input.digest, actual };
  }

  const key = evidenceKey(input);
  const existing = await bucket.head(key);
  if (existing !== null) {
    // Same key means same content by construction, so this is a duplicate write
    // and not a conflict — unless the stored size disagrees, which would mean the
    // bucket holds something that is not what its name says.
    if (existing.size !== input.bytes.byteLength) {
      return { stored: false, reason: "CONTENT_CONFLICT", key };
    }
    return { stored: true, key, deduplicated: true };
  }

  await hooks.beforePut?.(key);
  await bucket.put(key, input.bytes, {
    httpMetadata: { contentType: "application/jose" },
    customMetadata: {
      projectId: input.projectId,
      kind: input.kind,
      digest: input.digest,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    },
  });
  return { stored: true, key, deduplicated: false };
}

export type GetResult =
  | { readonly found: true; readonly bytes: Uint8Array }
  | { readonly found: false; readonly reason: "MISSING" }
  | { readonly found: false; readonly reason: "DIGEST_MISMATCH"; readonly actual: Sha256 };

/**
 * Fetch evidence and verify it against its own name before returning it. A store
 * that returned unverified bytes would make every caller responsible for a check
 * that only has one correct implementation.
 */
export async function getEvidence(
  bucket: R2Like,
  input: {
    readonly projectId: string;
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly kind: EvidenceKind;
    readonly digest: Sha256;
  },
): Promise<GetResult> {
  const object = await bucket.get(evidenceKey(input)) ?? await bucket.get(legacyEvidenceKey(input));
  if (object === null) return { found: false, reason: "MISSING" };
  const bytes = new Uint8Array(await object.arrayBuffer());
  const actual = await digestOf(bytes);
  if (actual !== input.digest) return { found: false, reason: "DIGEST_MISMATCH", actual };
  return { found: true, bytes };
}

/**
 * Write the scheduling decision an offer is about to bind, and hand back its
 * digest.
 *
 * The digest is taken over the same canonical bytes that are stored, so the
 * assignment a device checks names bytes a reader can fetch and hash for
 * themselves. Where the deployment has no bucket the digest is still the digest
 * of the real record; what is missing is the archive, not the explanation.
 *
 * A refused write throws. An offer whose decision was rejected by the store
 * would name a record nobody can read, which is the defect this producer exists
 * to end, one layer down.
 */
export function queueDecisionRecorder(input: {
  readonly db: D1Like;
  readonly bucket: R2Like | undefined;
  readonly repositoryId: string;
  readonly projectId?: string;
  /** Renew and validate the held project incarnation immediately before R2. */
  readonly beforeWrite?: () => Promise<boolean>;
}): DecisionRecorder {
  return async (decision) => {
    const bytes = canonicalRecordBytes(decision);
    const digest = await envelopeDigest(bytes);
    if (input.bucket === undefined || input.projectId === undefined) return digest;
    // Evidence is tenant-scoped, so a repository this deployment has no project
    // row for has nowhere to put it.
    const row = await input.db
      .prepare(
        `SELECT p.organization_id AS id FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.github_repository_id = ? AND o.status = 'active'
            AND (? IS NULL OR p.id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM project_release_requests r
               WHERE r.github_repository_id = p.github_repository_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_release_jobs r
               WHERE r.github_repository_id = p.github_repository_id
            )`,
      )
      .bind(input.repositoryId, input.projectId, input.projectId)
      .first<{ id: string }>();
    if (row === null) return digest;
    if (input.beforeWrite !== undefined && !(await input.beforeWrite())) {
      throw new Error(`queue decision ${digest} belongs to a released project incarnation`);
    }
    const intentState: { lease: R2WriteIntentLease | null } = { lease: null };
    try {
      const result = await putEvidence(input.bucket, {
        projectId: input.projectId,
        organizationId: row.id,
        repositoryId: input.repositoryId,
        kind: "queue-decision",
        digest,
        bytes,
      }, {
        beforePut: async (key) => {
          intentState.lease = await beginR2WriteIntent(input.db, {
            key,
            projectId: input.projectId!,
            organizationId: row.id,
            repositoryId: input.repositoryId,
          });
          if (intentState.lease === null) throw new Error(`queue decision ${digest} lost its project before R2`);
        },
      });
      if (!result.stored) throw new Error(`queue decision ${digest} was refused by the store: ${result.reason}`);
      const current = await input.db
        .prepare(
          `SELECT 1 AS found FROM projects p JOIN organizations o ON o.id = p.organization_id
            WHERE p.github_repository_id = ? AND p.id = ? AND o.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
              AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)`,
        )
        .bind(input.repositoryId, input.projectId)
        .first<{ found: number }>();
      if (current === null) {
        if (intentState.lease !== null) {
          await intentState.lease.compensate(input.bucket);
          intentState.lease = null;
        } else await input.bucket.delete(result.key);
        throw new Error(`queue decision ${digest} completed after its project incarnation was released`);
      }
      await intentState.lease?.complete();
      intentState.lease = null;
      return digest;
    } catch (error) {
      if (intentState.lease !== null) {
        await intentState.lease.markCleanup().catch(() => {
          // The existing durable intent remains. Its lease expires if this
          // invocation can no longer prove ownership.
        });
      }
      throw error;
    }
  };
}
