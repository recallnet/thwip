import { describe, expect, it } from "vitest";
import { publicJwkFrom } from "./service-keys.js";

/**
 * A signature nobody else can check is decoration. This turns the private key
 * the Worker signs with into the public key a reader verifies with, and it must
 * never leak the private half while doing so.
 */
describe("the public half of the signing key", () => {
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
    kid: "thwip-svc-1",
  };

  it("keeps every field a verifier needs", () => {
    const pub = publicJwkFrom(privateJwk);
    expect(pub).toMatchObject({ kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, kid: "thwip-svc-1" });
  });

  it("never carries the private scalar", () => {
    expect(publicJwkFrom(privateJwk)).not.toHaveProperty("d");
  });

  it("marks the key as verification-only", () => {
    expect(publicJwkFrom(privateJwk)).toMatchObject({ use: "sig", alg: "ES256" });
  });

  it("refuses a key with no id, because a verifier selects by id", () => {
    const { kid: _drop, ...anonymous } = privateJwk;
    expect(() => publicJwkFrom(anonymous)).toThrow(/kid/i);
  });
});
