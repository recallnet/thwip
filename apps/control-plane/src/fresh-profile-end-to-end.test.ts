import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deriveProjectConfig, type RepositorySnapshot, type ThwipYaml } from "@thwip/policy";
import { verifyProof, type GithubFacts } from "@thwip/verifier";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { attachTrailer, buildStatement, signStatement } from "../../../packages/cli/src/proof.js";
import { mintRunLease } from "./run-lease.js";
import { resolveVerificationBundle } from "./verification-bundle.js";
import { verifySshSigEd25519 } from "./sshsig-verify.js";
import type { Env } from "./env.js";

/**
 * `fresh` end to end, with nothing about the lease stubbed.
 *
 * The verifier's lease check was written, reviewed and merged while every
 * caller still fed it blanks, so it enforced nothing. A unit test cannot catch
 * that, because a unit test supplies exactly what production forgot. So this
 * one runs the real pieces against each other: the policy a repository's
 * `thwip.yaml` derives, the bundle the control plane serves, the lease the
 * control plane mints, a statement the CLI builds and a real ssh key signs,
 * and the verifier with no lease dependency injected into it at all.
 *
 * GitHub is the one party that cannot run here, so the call listing a user's
 * signing keys is answered locally. Everything else is production code.
 */

const execFileP = promisify(execFile);
const REPO = "1315419165";
const OWNER = "162603603";
const USER = "264261678";
const LOGIN = "signer";

class EmptySnapshot implements RepositorySnapshot {
  async hasFile(path: string) {
    return path === "pnpm-lock.yaml";
  }
  async listFiles() {
    return [];
  }
  async readFile(): Promise<Uint8Array> {
    throw new Error("no files");
  }
}

let keyDir: string;
let privateKeyPath: string;
let publicKey: string;
let fingerprint: string;
const realFetch = globalThis.fetch;
const open: Array<{ close(): void }> = [];
let kids = 0;

beforeAll(async () => {
  keyDir = await mkdtemp(join(tmpdir(), "thwip-fresh-e2e-"));
  privateKeyPath = join(keyDir, "id_ed25519");
  await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "thwip-e2e", "-f", privateKeyPath]);
  const { stdout } = await execFileP("ssh-keygen", ["-l", "-f", `${privateKeyPath}.pub`]);
  fingerprint = stdout.split(/\s+/)[1]!;
  const { readFile } = await import("node:fs/promises");
  publicKey = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
  // GitHub's answer about which keys this user publishes. The only stub here.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ssh_signing_keys")) {
      return new Response(JSON.stringify([{ id: 1, key: publicKey, title: "e2e" }]), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(keyDir, { recursive: true, force: true });
});

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

async function project(profile: ThwipYaml["profile"]) {
  const yaml: ThwipYaml = { version: 1, profile, required: ["test"] };
  const derived = await deriveProjectConfig(yaml, { ownerId: OWNER, repositoryId: REPO }, new EmptySnapshot());
  const t = testD1();
  open.push(t);
  t.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', ?, 'recallnet')")
    .run(OWNER);
  t.raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest, security_profile)
       VALUES ('prj_1', 'org_1', ?, 'recallnet/thwip', 'main', 1, ?, ?)`,
    )
    .run(REPO, derived.policyDigest, profile);
  t.raw
    .prepare(
      "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status, config_source) VALUES (?, 'prj_1', 1, ?, 'active', 'repository-override')",
    )
    .run(derived.policyDigest, JSON.stringify(derived.policy));
  t.raw
    .prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active, synced_at) VALUES ('prj_1', ?, ?, 'write', 1, ?)",
    )
    .run(USER, LOGIN, new Date().toISOString());
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.privateKey)), kid: `e2e-svc-${++kids}`, alg: "ES256" };
  const env = {
    DB: t.db,
    THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
    PUBLIC_ORIGIN: "https://thwip.example",
    GITHUB_SYNC_TOKEN: "token",
  } as unknown as Env;
  return { env, derived };
}

const TREE = "1".repeat(40);
const PARENT = "2".repeat(40);
const BASE = "3".repeat(40);
const HEAD = "4".repeat(40);

const subject = {
  headSha: HEAD,
  treeOid: TREE,
  parentOids: [PARENT],
  baseRef: "refs/heads/main",
  baseSha: BASE,
  objectFormat: "sha1" as const,
};

const facts: GithubFacts = {
  ownerId: OWNER,
  repositoryId: REPO,
  headSha: HEAD,
  treeOid: TREE,
  parentOids: [PARENT],
  baseRef: "refs/heads/main",
  baseSha: BASE,
  objectFormat: "sha1",
  prAuthorGithubUserId: USER,
};

/** Exactly what `thwip run` does, with the lease it was handed. */
async function proofCommit(
  derived: Awaited<ReturnType<typeof project>>["derived"],
  lease: string | undefined,
  window: { startedAt: string; finishedAt: string },
) {
  const statement = buildStatement({
    subject,
    ownerId: OWNER,
    repositoryId: REPO,
    policyDigest: derived.policyDigest,
    policyVersion: derived.policy.version,
    pipelineDigest: derived.pipelineDigest,
    runner: "command",
    suites: [{ id: "test", status: "passed", durationMs: 10 }],
    startedAt: window.startedAt,
    finishedAt: window.finishedAt,
    keyId: fingerprint,
    githubUserId: USER,
    privateKeyPath,
    ...(lease !== undefined ? { lease } : {}),
  });
  const envelope = await signStatement(statement, fingerprint, privateKeyPath);
  return attachTrailer("feat: a change", envelope);
}

async function bundleFor(env: Env) {
  const resolution = await resolveVerificationBundle(env, {
    repositoryId: REPO,
    signerGithubUserId: USER,
    keyFingerprint: fingerprint,
  });
  if (resolution.kind !== "active") throw new Error("expected an active policy");
  return resolution.bundle;
}

/**
 * No lease dependency. This is the point of the file: if a caller in
 * production passes nothing, this is what it gets, and it has to be a real
 * check.
 */
const verify = (commitMessage: string, bundle: Awaited<ReturnType<typeof bundleFor>>) =>
  verifyProof(
    { commitMessage, facts, bundle, now: new Date().toISOString() },
    { verifySshSignature: verifySshSigEd25519 },
  );

const window = () => {
  const started = new Date(Date.now() - 30_000).toISOString();
  return { startedAt: started, finishedAt: new Date().toISOString() };
};

describe("a repository on fresh", () => {
  it("accepts a proof whose run happened inside a lease this service minted", async () => {
    const { env, derived } = await project("fresh");
    const lease = await mintRunLease(env, {
      project: { activePolicyDigest: derived.policyDigest, securityProfile: "fresh" },
      request: { repositoryId: REPO, treeOid: TREE, parentOids: [PARENT], baseSha: BASE, deviceKeyId: fingerprint },
      leaseSeconds: derived.policy.lease.maxAgeSeconds,
    });
    const result = await verify(await proofCommit(derived, lease, window()), await bundleFor(env));
    expect(result.code).toBe("PASS");
  });

  it("refuses the same proof with no lease on it", async () => {
    const { env, derived } = await project("fresh");
    const result = await verify(await proofCommit(derived, undefined, window()), await bundleFor(env));
    expect(result.code).toBe("LEASE_REQUIRED");
  });

  it("refuses a lease minted for a different tree", async () => {
    const { env, derived } = await project("fresh");
    const lease = await mintRunLease(env, {
      project: { activePolicyDigest: derived.policyDigest, securityProfile: "fresh" },
      request: {
        repositoryId: REPO,
        treeOid: "9".repeat(40),
        parentOids: [PARENT],
        baseSha: BASE,
        deviceKeyId: fingerprint,
      },
      leaseSeconds: derived.policy.lease.maxAgeSeconds,
    });
    const result = await verify(await proofCommit(derived, lease, window()), await bundleFor(env));
    expect(result.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("refuses a lease minted on another device", async () => {
    const { env, derived } = await project("fresh");
    const lease = await mintRunLease(env, {
      project: { activePolicyDigest: derived.policyDigest, securityProfile: "fresh" },
      request: {
        repositoryId: REPO,
        treeOid: TREE,
        parentOids: [PARENT],
        baseSha: BASE,
        deviceKeyId: "SHA256:some-other-machine",
      },
      leaseSeconds: derived.policy.lease.maxAgeSeconds,
    });
    const result = await verify(await proofCommit(derived, lease, window()), await bundleFor(env));
    expect(result.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("refuses a lease signed by somebody else", async () => {
    const { env, derived } = await project("fresh");
    const impostor = await project("fresh");
    const lease = await mintRunLease(impostor.env, {
      project: { activePolicyDigest: derived.policyDigest, securityProfile: "fresh" },
      request: { repositoryId: REPO, treeOid: TREE, parentOids: [PARENT], baseSha: BASE, deviceKeyId: fingerprint },
      leaseSeconds: derived.policy.lease.maxAgeSeconds,
    });
    const result = await verify(await proofCommit(derived, lease, window()), await bundleFor(env));
    expect(result.code).toBe("LEASE_INVALID");
  });

  it("refuses a lease wrapped around a run that had already finished", async () => {
    const { env, derived } = await project("fresh");
    const lease = await mintRunLease(env, {
      project: { activePolicyDigest: derived.policyDigest, securityProfile: "fresh" },
      request: { repositoryId: REPO, treeOid: TREE, parentOids: [PARENT], baseSha: BASE, deviceKeyId: fingerprint },
      leaseSeconds: derived.policy.lease.maxAgeSeconds,
    });
    const yesterday = new Date(Date.now() - 3_600_000).toISOString();
    const result = await verify(
      await proofCommit(derived, lease, { startedAt: yesterday, finishedAt: yesterday }),
      await bundleFor(env),
    );
    expect(result.code).toBe("LEASE_CONTEXT_MISMATCH");
  });
});

describe("the same repository on fast", () => {
  it("accepts the leaseless proof fresh refused, which is the whole difference", async () => {
    const { env, derived } = await project("fast");
    const result = await verify(await proofCommit(derived, undefined, window()), await bundleFor(env));
    expect(result.code).toBe("PASS");
  });
});
