import { generateKeyPair, SignJWT, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, githubOidcAudiences } from "./github-oidc.js";

const PRIMARY_ORIGIN = "https://thwip.ai";
const LEGACY_ORIGIN = "https://thwip.recall.net";

async function oidcToken(audience: string, privateKey: CryptoKey): Promise<string> {
  return new SignJWT({ repository_id: "1234" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("GitHub OIDC audiences", () => {
  it("keeps the ordinary one-audience gate without a distinct legacy origin", () => {
    expect(githubOidcAudiences({ PUBLIC_ORIGIN: PRIMARY_ORIGIN })).toBe(
      `${PRIMARY_ORIGIN}/api/github-actions`,
    );
    expect(
      githubOidcAudiences({
        PUBLIC_ORIGIN: PRIMARY_ORIGIN,
        LEGACY_ORIGIN: PRIMARY_ORIGIN,
      }),
    ).toBe(`${PRIMARY_ORIGIN}/api/github-actions`);
  });

  it("accepts the current and legacy audiences during the hostname transition", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const audiences = githubOidcAudiences({
      PUBLIC_ORIGIN: PRIMARY_ORIGIN,
      LEGACY_ORIGIN,
    });

    await expect(
      jwtVerify(await oidcToken(`${PRIMARY_ORIGIN}/api/github-actions`, privateKey), publicKey, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: audiences,
      }),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(await oidcToken(`${LEGACY_ORIGIN}/api/github-actions`, privateKey), publicKey, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: audiences,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects an audience outside the configured transition", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const audiences = githubOidcAudiences({
      PUBLIC_ORIGIN: PRIMARY_ORIGIN,
      LEGACY_ORIGIN,
    });

    await expect(
      jwtVerify(await oidcToken("https://attacker.example/api/github-actions", privateKey), publicKey, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: audiences,
      }),
    ).rejects.toThrow();
  });
});
