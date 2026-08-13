import { compactVerify, createLocalJWKSet, type JSONWebKeySet, type JWK } from "jose";
import type { D1Like } from "./queue/projection.js";

/**
 * The public half of a signing key, for anyone verifying a record.
 *
 * Every signed record the queue produces carries a JWS, and until this existed
 * the only party able to check one was the party that made it. A signature only
 * its author can verify proves nothing to a reader.
 *
 * The private scalar is dropped explicitly rather than by picking fields off a
 * spread, because a future key type with a different private field would
 * otherwise be published whole.
 */
export function publicJwkFrom(jwk: JWK): JWK {
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
    throw new Error("a signing key needs a kid; verifiers select the key by id");
  }
  const { d: _private, ...rest } = jwk;
  return { ...rest, use: "sig", alg: "ES256" };
}

/**
 * Remember the key the service is signing with.
 *
 * Called on the paths that sign, so a key that has ever produced a signature is
 * always publishable. Writing on conflict does nothing: the row is the public
 * half and it never changes for a given id.
 */
export async function recordActiveKey(db: D1Like, jwk: JWK): Promise<void> {
  const pub = publicJwkFrom(jwk);
  // The lifecycle D1 cutover enters database-enforced maintenance before it
  // exports. A cold isolate must still be able to sign /health without issuing
  // even an INSERT ... ON CONFLICT against the fenced source database.
  const existing = await db
    .prepare("SELECT 1 FROM service_keys WHERE kid = ? LIMIT 1")
    .bind(pub.kid)
    .first<{ 1: number }>();
  if (existing !== null) return;
  await db
    .prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?) ON CONFLICT(kid) DO NOTHING")
    .bind(pub.kid, JSON.stringify(pub))
    .run();
}

/** Every key a reader may need, active and retired alike. */
export async function verificationKeys(db: D1Like): Promise<JWK[]> {
  const rows = await db.prepare("SELECT public_jwk FROM service_keys ORDER BY created_at").bind().all<{ public_jwk: string }>();
  return rows.results.map((r) => JSON.parse(r.public_jwk) as JWK);
}

/** Verify that the service signed these exact bytes with any published key. */
export async function verifyServiceSignature(
  db: D1Like,
  bytes: Uint8Array,
  jws: string,
  expectedType?: string,
): Promise<boolean> {
  // Reading the trust roots is an infrastructure operation. If it fails the
  // caller must retry; treating that failure as an invalid signature can make
  // merge recovery sign replacement bytes for a valid staged record.
  const published: JSONWebKeySet = { keys: await verificationKeys(db) };
  try {
    const { payload, protectedHeader } = await compactVerify(jws, createLocalJWKSet(published));
    return (
      (expectedType === undefined || protectedHeader.typ === expectedType) &&
      payload.length === bytes.length &&
      payload.every((value, index) => value === bytes[index])
    );
  } catch {
    return false;
  }
}
