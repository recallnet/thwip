import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { resolveVerificationBundle, VerificationBundleError } from "./verification-bundle.js";
import type { Env } from "./env.js";

/**
 * Who a verifier may check a run lease against.
 *
 * The bundle shipped `leaseIssuerJwks: []` for every project. A verifier with
 * no issuer key cannot tell a real lease from a forged one, so it refuses
 * every lease, and a policy that requires one could never be satisfied. The
 * keys are the service's own signing keys, which is the same material every
 * signed record is checked against.
 */

const REPO = "1315419165";
const DIGEST = `sha256:${"b".repeat(64)}`;

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let kids = 0;

async function env(policy: Record<string, unknown>): Promise<Env> {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'recallnet')").run();
  raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest, security_profile)
       VALUES ('prj_1', 'org_1', ?, 'recallnet/thwip', 'main', 1, ?, 'fast')`,
    )
    .run(REPO, DIGEST);
  raw
    .prepare(
      "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status, config_source) VALUES (?, 'prj_1', 4, ?, 'active', 'repository-override')",
    )
    .run(DIGEST, JSON.stringify(policy));
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.privateKey)), kid: `bundle-test-${++kids}`, alg: "ES256" };
  return {
    DB: t.db,
    THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
    PUBLIC_ORIGIN: "https://thwip.example",
  } as unknown as Env;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const policyFor = (lease: { required: boolean; maxAgeSeconds: number }) => ({
  schemaVersion: "1",
  securityProfile: lease.required ? "fresh" : "fast",
  version: 4,
  lease,
  pipeline: { digest: `sha256:${"c".repeat(64)}`, runner: "command", requiredSuites: ["test"] },
});

describe("the keys a bundle offers for checking a lease", () => {
  it("publishes the issuer keys when the policy requires a lease", async () => {
    const resolution = await resolveVerificationBundle(await env(policyFor({ required: true, maxAgeSeconds: 1800 })), {
      repositoryId: REPO,
    });
    if (resolution.kind !== "active") throw new Error("expected an active policy");
    expect(resolution.bundle.leaseIssuerJwks.length).toBeGreaterThan(0);
    const [jwk] = resolution.bundle.leaseIssuerJwks as Array<Record<string, unknown>>;
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
    // The public half only. A bundle is served to anyone who can read the
    // repository, and a private scalar in it would be the whole service.
    expect(jwk!["d"]).toBeUndefined();
  });

  it("carries the same keys under fast, so turning a profile on needs no key rollout", async () => {
    const resolution = await resolveVerificationBundle(await env(policyFor({ required: false, maxAgeSeconds: 1800 })), {
      repositoryId: REPO,
    });
    if (resolution.kind !== "active") throw new Error("expected an active policy");
    expect(resolution.bundle.leaseIssuerJwks.length).toBeGreaterThan(0);
  });

  it("refuses to serve a lease-requiring bundle with no issuer key", async () => {
    const broken = await env(policyFor({ required: true, maxAgeSeconds: 1800 }));
    (broken as { THWIP_SERVICE_SIGNING_PRIVATE_JWK: string }).THWIP_SERVICE_SIGNING_PRIVATE_JWK = "not-a-jwk";
    await expect(resolveVerificationBundle(broken, { repositoryId: REPO })).rejects.toBeInstanceOf(
      VerificationBundleError,
    );
  });

  it("refuses a resolver that holds an earlier project incarnation", async () => {
    const current = await env(policyFor({ required: false, maxAgeSeconds: 1800 }));
    await expect(
      resolveVerificationBundle(current, { repositoryId: REPO, expectedProjectId: "prj_removed" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
