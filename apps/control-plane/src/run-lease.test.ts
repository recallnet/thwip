import { LEASE_AUDIENCE } from "@thwip/protocol";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { mintRunLease } from "./run-lease.js";
import type { Env } from "./env.js";

/**
 * The window a lease opens.
 *
 * A lease is the whole of what `fresh` adds over `fast`: the run happened
 * inside a window this service opened, for this exact tree, on this device,
 * under this policy. Every claim the verifier judges is minted here, so the
 * two have to be checked against each other rather than against a copy of the
 * shape written twice.
 */

const TREE = "a".repeat(40);
const PARENT = "b".repeat(40);
const BASE = "c".repeat(40);

// A fresh kid per env: `serviceKey` remembers which keys this isolate has
// already published, so two tests sharing a kid would leave the second with
// nothing to observe.
let kids = 0;

async function envWithKey(): Promise<{ env: Env; rows: Array<[string, string]>; kid: string }> {
  const kid = `svc-test-${++kids}`;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.privateKey)), kid, alg: "ES256" };
  const rows: Array<[string, string]> = [];
  const env = {
    THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
    DB: {
      prepare() {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                rows.push([String(args[0]), String(args[1])]);
                return { success: true };
              },
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, rows, kid };
}

const request = {
  repositoryId: "1315419165",
  treeOid: TREE,
  parentOids: [PARENT],
  baseSha: BASE,
  deviceKeyId: "SHA256:device",
};

const project = { activePolicyDigest: `sha256:${"1".repeat(64)}`, securityProfile: "fresh" };

describe("minting a run lease", () => {
  it("names the run it was minted for, so it proves nothing about another one", async () => {
    const { env, kid } = await envWithKey();
    const lease = await mintRunLease(env, { project, request, leaseSeconds: 1800 });
    const jwk = JSON.parse(env.THWIP_SERVICE_SIGNING_PRIVATE_JWK) as Record<string, unknown>;
    const { payload, protectedHeader } = await jwtVerify(lease, await keyOf(jwk), {
      audience: LEASE_AUDIENCE,
    });
    expect(protectedHeader.kid).toBe(kid);
    expect(payload).toMatchObject({
      repositoryId: request.repositoryId,
      treeOid: TREE,
      parentOids: [PARENT],
      baseSha: BASE,
      deviceKeyId: request.deviceKeyId,
      policyDigest: project.activePolicyDigest,
      profile: "fresh",
    });
  });

  it("expires when the policy stops accepting it, not later", async () => {
    const { env } = await envWithKey();
    const lease = await mintRunLease(env, { project, request, leaseSeconds: 600 });
    const claims = JSON.parse(
      Buffer.from(lease.split(".")[1]!, "base64url").toString("utf8"),
    ) as { iat: number; exp: number; nbf: number };
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.nbf).toBeLessThanOrEqual(claims.iat);
  });

  it("publishes the key it signed with, so a reader can check the lease", async () => {
    const { env, rows, kid } = await envWithKey();
    await mintRunLease(env, { project, request, leaseSeconds: 1800 });
    expect(rows.some(([written]) => written === kid)).toBe(true);
    expect(rows.every(([, jwk]) => !jwk.includes('"d"'))).toBe(true);
  });

  it("refuses a window nobody bounded", async () => {
    const { env } = await envWithKey();
    await expect(mintRunLease(env, { project, request, leaseSeconds: 0 })).rejects.toThrow(/lease/i);
  });
});

async function keyOf(jwk: Record<string, unknown>) {
  const { importJWK } = await import("jose");
  const { d: _private, ...pub } = jwk;
  return importJWK(pub, "ES256");
}
