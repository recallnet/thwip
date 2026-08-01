/**
 * The one piece of maths the lease check needs, in one place.
 *
 * `verifyProof` parses the lease, picks the candidate keys and judges every
 * claim itself; all it delegates is "is this signature good under this key".
 * Both callers — the Action and the App — used to pass nothing here, which
 * made every lease refuse, so there is exactly one implementation and both
 * import it rather than each writing its own.
 *
 * WebCrypto only. The verifier package has no crypto dependency and gains none.
 */

const ALGORITHMS: Record<string, { importParams: EcKeyImportParams | Algorithm; verifyParams: EcdsaParams | Algorithm; kty: string }> = {
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
    kty: "EC",
  },
  EdDSA: {
    importParams: { name: "Ed25519" },
    verifyParams: { name: "Ed25519" },
    kty: "OKP",
  },
};

/**
 * True only when the signature is good. Anything unreadable — an algorithm
 * this build cannot do, a key of the wrong type, a malformed JWK — is false,
 * because the caller reads false as a refusal and an exception escaping here
 * would be read as a checker fault rather than a bad lease.
 */
export async function verifyLeaseSignature(args: {
  jwk: unknown;
  algorithm: string;
  signingInput: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  const spec = ALGORITHMS[args.algorithm];
  if (spec === undefined) return false;
  const jwk = args.jwk as JsonWebKey & { alg?: string };
  if (typeof jwk !== "object" || jwk === null || jwk.kty !== spec.kty) return false;
  // A key published for one algorithm must not be pressed into another.
  if (typeof jwk.alg === "string" && jwk.alg !== args.algorithm) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"], ext: true }, spec.importParams, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(spec.verifyParams, key, args.signature as BufferSource, args.signingInput as BufferSource);
  } catch {
    return false;
  }
}
