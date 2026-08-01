import { describe, expect, it } from "vitest";
import { verifyLeaseSignature } from "./lease-signature.js";

/**
 * A lease signature check that says true when it cannot tell would let any
 * forged lease through, so every unreadable case here has to be false.
 */

const input = new TextEncoder().encode("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJydW4ifQ");

async function es256() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, input as BufferSource),
  );
  return { jwk, signature };
}

describe("checking a lease signature", () => {
  it("accepts a signature the issuer really made", async () => {
    const { jwk, signature } = await es256();
    expect(await verifyLeaseSignature({ jwk, algorithm: "ES256", signingInput: input, signature })).toBe(true);
  });

  it("refuses a signature over other bytes", async () => {
    const { jwk, signature } = await es256();
    const other = new TextEncoder().encode("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9");
    expect(await verifyLeaseSignature({ jwk, algorithm: "ES256", signingInput: other, signature })).toBe(false);
  });

  it("refuses a signature made by another key", async () => {
    const { signature } = await es256();
    const other = await es256();
    expect(
      await verifyLeaseSignature({ jwk: other.jwk, algorithm: "ES256", signingInput: input, signature }),
    ).toBe(false);
  });

  it("refuses an algorithm it does not do, rather than passing it", async () => {
    const { jwk, signature } = await es256();
    expect(await verifyLeaseSignature({ jwk, algorithm: "none", signingInput: input, signature })).toBe(false);
    expect(await verifyLeaseSignature({ jwk, algorithm: "HS256", signingInput: input, signature })).toBe(false);
  });

  it("refuses a key published for a different algorithm", async () => {
    const { jwk, signature } = await es256();
    expect(
      await verifyLeaseSignature({ jwk: { ...jwk, alg: "ES384" }, algorithm: "ES256", signingInput: input, signature }),
    ).toBe(false);
    expect(await verifyLeaseSignature({ jwk, algorithm: "EdDSA", signingInput: input, signature })).toBe(false);
  });

  it("refuses anything that is not a key at all", async () => {
    const { signature } = await es256();
    for (const jwk of [null, undefined, "a string", {}, { kty: "EC" }]) {
      expect(await verifyLeaseSignature({ jwk, algorithm: "ES256", signingInput: input, signature })).toBe(false);
    }
  });
});
