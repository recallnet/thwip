import { bytesDigest, canonicalDigest, canonicalJson, dssePae, utf8Encode, type Sha256 } from "@thwip/protocol";

/**
 * Canonicalization and digest rules for queue evidence.
 *
 * The rule that matters: a record's digest is the SHA-256 of
 * the exact signed envelope bytes, never of JSON reconstructed from a parsed
 * object. Reconstruction would let two different byte strings share a digest
 * and turn a signature into a statement about something nobody signed.
 */

/** Typed Thwip predicate URNs for the queue records (§47.3). */
export const QUEUE_PREDICATE_TYPES = {
  queueDecision: "urn:thwip:attestation:queue-decision:v1",
  integrationAssignment: "urn:thwip:attestation:integration-assignment:v1",
  integrationRun: "urn:thwip:attestation:integration-run:v1",
  exactReceiptReuse: "urn:thwip:attestation:exact-receipt-reuse:v1",
  verifierResult: "urn:thwip:attestation:verifier-result:v1",
  mergeIntent: "urn:thwip:attestation:merge-intent:v1",
  transitionRecord: "urn:thwip:attestation:transition-record:v1",
} as const;

export type QueuePredicateType = (typeof QUEUE_PREDICATE_TYPES)[keyof typeof QUEUE_PREDICATE_TYPES];

/** SSHSIG namespace for queue evidence, distinct from the CI-proof namespace. */
export const QUEUE_SIGN_NAMESPACE = "thwip-queue-dsse-v1" as const;

/**
 * The digest of a record as content, used where the spec names a payload digest
 * (policy digest, receipt digest, and similar). RFC 8785 canonical JSON.
 */
export async function recordDigest(value: unknown): Promise<Sha256> {
  return canonicalDigest(value);
}

/**
 * The digest of a signed envelope, computed over the bytes as received.
 * Callers must keep the original bytes; passing a re-serialized object here is
 * the mistake this function exists to make impossible to write by accident.
 */
export async function envelopeDigest(envelopeBytes: Uint8Array): Promise<Sha256> {
  return bytesDigest(envelopeBytes);
}

/** Bytes to sign for a queue record, domain-separated by predicate type. */
export function queueSigningBytes(predicateType: QueuePredicateType, payload: Uint8Array): Uint8Array {
  return dssePae(predicateType, payload);
}

/** The exact bytes `recordDigest` hashes, for callers that must store them. */
export function canonicalRecordBytes(value: unknown): Uint8Array {
  return utf8Encode(canonicalJson(value));
}

/** Canonical payload bytes for a record about to be signed. */
export function canonicalBytes(canonicalJson: string): Uint8Array {
  return utf8Encode(canonicalJson);
}

/**
 * Digest of an ordered vector of object ids, used by transition records to bind
 * a full parent list while embedding at most sixteen of them (§21.9). The
 * separator prevents two different vectors sharing a preimage.
 */
export async function parentOidsDigest(parentOids: readonly string[]): Promise<Sha256> {
  return bytesDigest(utf8Encode(parentOids.map((oid) => `${oid}\n`).join("")));
}

/**
 * Digest of the required-suite set for fast-path equivalence (§21.5). Order is
 * normalized because two policies requiring the same suites in a different
 * order require the same work.
 */
export async function requiredSuitesDigest(suites: readonly string[]): Promise<Sha256> {
  const unique = [...new Set(suites)].sort();
  return bytesDigest(utf8Encode(unique.map((s) => `${s}\n`).join("")));
}
