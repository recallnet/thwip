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
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly kind: EvidenceKind;
  readonly digest: Sha256;
}): string {
  const hex = input.digest.slice("sha256:".length);
  // Two-level fan-out on the digest keeps any single prefix from growing without
  // bound, which matters for listing and lifecycle rules.
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
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly kind: EvidenceKind;
    readonly digest: Sha256;
    readonly bytes: Uint8Array;
    readonly attemptId?: string;
  },
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

  await bucket.put(key, input.bytes, {
    httpMetadata: { contentType: "application/jose" },
    customMetadata: {
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
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly kind: EvidenceKind;
    readonly digest: Sha256;
  },
): Promise<GetResult> {
  const object = await bucket.get(evidenceKey(input));
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
}): DecisionRecorder {
  return async (decision) => {
    const bytes = canonicalRecordBytes(decision);
    const digest = await envelopeDigest(bytes);
    if (input.bucket === undefined) return digest;
    // Evidence is tenant-scoped, so a repository this deployment has no project
    // row for has nowhere to put it.
    const row = await input.db
      .prepare("SELECT organization_id AS id FROM projects WHERE github_repository_id = ?")
      .bind(input.repositoryId)
      .first<{ id: string }>();
    if (row === null) return digest;
    const result = await putEvidence(input.bucket, {
      organizationId: row.id,
      repositoryId: input.repositoryId,
      kind: "queue-decision",
      digest,
      bytes,
    });
    if (!result.stored) throw new Error(`queue decision ${digest} was refused by the store: ${result.reason}`);
    return digest;
  };
}
