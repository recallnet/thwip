import { LEASE_AUDIENCE } from "@thwip/protocol";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { mintRunLease, withAuthorizedRunLeaseProject } from "./run-lease.js";
import type { Env } from "./env.js";
import { testD1 } from "../test/d1.js";

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

const project = { id: "project_1", activePolicyDigest: `sha256:${"1".repeat(64)}`, securityProfile: "fresh" };

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
      projectId: project.id,
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

  it("authorizes the exact user, project, and live device before calling the signer", async () => {
    const t = testD1();
    try {
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_a', '1', 'alpha')").run();
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_b', '2', 'beta')").run();
      t.raw
        .prepare(
          "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('project_a', 'org_a', '100', 'alpha/repo', 1)",
        )
        .run();
      t.raw
        .prepare(
          "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('project_b', 'org_b', ?, 'beta/repo', 1)",
        )
        .run(request.repositoryId);
      t.raw
        .prepare(
          "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES ('project_a', 'user_a', 'alice', 'admin', 1)",
        )
        .run();
      t.raw
        .prepare(
          "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES ('project_b', 'user_b', 'bob', 'write', 1)",
        )
        .run();
      t.raw
        .prepare(
          "INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label) VALUES ('device_a', 'user_a', 'ssh-ed25519', 'key-a', 'device_a', 'a')",
        )
        .run();
      t.raw
        .prepare(
          "INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label) VALUES ('device_b', 'user_b', 'ssh-ed25519', 'key-b', 'device_b', 'b')",
        )
        .run();

      let signed = 0;
      const sign = async () => {
        signed += 1;
        return "signed";
      };
      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_a" },
          "device_a",
          sign,
        ),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_b" },
          "device_a",
          sign,
        ),
      ).resolves.toEqual({ kind: "forbidden" });
      t.raw.prepare("UPDATE device_keys SET revoked_at = 'now' WHERE key_id = 'device_b'").run();
      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_b" },
          "device_b",
          sign,
        ),
      ).resolves.toEqual({ kind: "forbidden" });
      expect(signed).toBe(0);

      await expect(
        withAuthorizedRunLeaseProject(t.db, request.repositoryId, { kind: "admin" }, "operator-device", sign),
      ).resolves.toEqual({ kind: "current", value: "signed" });
      expect(signed).toBe(1);

      t.raw.prepare("UPDATE device_keys SET revoked_at = NULL WHERE key_id = 'device_b'").run();
      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_b" },
          "device_b",
          sign,
        ),
      ).resolves.toEqual({ kind: "current", value: "signed" });
      expect(signed).toBe(2);

      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_b" },
          "device_b",
          async () => {
            signed += 1;
            t.raw.prepare("UPDATE device_keys SET revoked_at = 'during-mint' WHERE key_id = 'device_b'").run();
            return "signed-but-revoked";
          },
        ),
      ).resolves.toEqual({ kind: "released" });
      expect(signed).toBe(3);

      t.raw.prepare("UPDATE device_keys SET revoked_at = NULL WHERE key_id = 'device_b'").run();
      await expect(
        withAuthorizedRunLeaseProject(
          t.db,
          request.repositoryId,
          { kind: "user", githubUserId: "user_b" },
          "device_b",
          sign,
          {
            beforeFinalAuthorityCheck: async () => {
              t.raw
                .prepare(
                  "INSERT INTO project_release_requests (github_repository_id, project_id, organization_id, github_name, default_branch) VALUES (?, 'project_b', 'org_b', 'beta/repo', 'main')",
                )
                .run(request.repositoryId);
            },
          },
        ),
      ).resolves.toEqual({ kind: "released" });
      expect(signed).toBe(4);
    } finally {
      t.close();
    }
  });
});

async function keyOf(jwk: Record<string, unknown>) {
  const { importJWK } = await import("jose");
  const { d: _private, ...pub } = jwk;
  return importJWK(pub, "ES256");
}
