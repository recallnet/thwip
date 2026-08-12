import { generateKeyPair, SignJWT, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, githubOidcAudience } from "./github-oidc.js";

const PUBLIC_ORIGIN = "https://thwip.ai";

async function oidcToken(audience: string, privateKey: CryptoKey): Promise<string> {
  return new SignJWT({ repository_id: "1234" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("GitHub OIDC audience", () => {
  it("uses the public origin as the only audience", () => {
    expect(githubOidcAudience({ PUBLIC_ORIGIN })).toBe(`${PUBLIC_ORIGIN}/api/github-actions`);
  });

  it("accepts the public audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const audience = githubOidcAudience({ PUBLIC_ORIGIN });

    await expect(
      jwtVerify(await oidcToken(audience, privateKey), publicKey, {
        issuer: GITHUB_OIDC_ISSUER,
        audience,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects every other audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const audience = githubOidcAudience({ PUBLIC_ORIGIN });

    await expect(
      jwtVerify(
        await oidcToken("https://unrelated.example/api/github-actions", privateKey),
        publicKey,
        {
          issuer: GITHUB_OIDC_ISSUER,
          audience,
        },
      ),
    ).rejects.toThrow();
  });
});
