import type { JWK } from "jose";

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
  const { d: _private, ...rest } = jwk as JWK & { d?: string };
  return { ...rest, use: "sig", alg: "ES256" };
}
