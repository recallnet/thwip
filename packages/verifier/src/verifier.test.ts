import { describe, expect, it } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  b64stdEncode,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { verifyProof, type GithubFacts, type VerifyDeps } from "./index.js";

const TREE = "a".repeat(40);
const PARENT = "b".repeat(40);
const BASE = "c".repeat(40);
const POLICY_DIGEST = `sha256:${"1".repeat(64)}` as const;
const PIPELINE_DIGEST = `sha256:${"2".repeat(64)}` as const;
const NOW = "2026-07-28T12:00:00Z";

function makeStatement(overrides?: (s: InTotoStatementV1) => void): InTotoStatementV1 {
  const s: InTotoStatementV1 = {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "162603603", repositoryId: "1315419165" },
      git: {
        objectFormat: "sha1",
        treeOid: TREE,
        parentOids: [PARENT],
        baseRef: "refs/heads/main",
        baseSha: BASE,
        evaluationMode: "head-tree",
      },
      policy: { digest: POLICY_DIGEST, version: 1 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command" },
      run: {
        startedAt: "2026-07-28T11:50:00Z",
        finishedAt: "2026-07-28T11:59:00Z",
        networkMode: "unrestricted",
        cacheMode: "read-write",
        suites: [
          { id: "lint", status: "passed", durationMs: 100 },
          { id: "typecheck", status: "passed", durationMs: 200 },
          { id: "test", status: "passed", durationMs: 300 },
        ],
      },
      signer: { keyId: "key_test1", githubUserId: "264261678" },
    },
  };
  overrides?.(s);
  return s;
}

function envelopeFor(statement: InTotoStatementV1, sig = "GOOD", keyid = "key_test1"): DsseEnvelope {
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: b64stdEncode(utf8Encode(JSON.stringify(statement))),
    signatures: [{ keyid, sig }],
  };
}

function commitMessageFor(envelope: DsseEnvelope): string {
  return `feat: something\n\n${encodeCarrier(envelope)}\n`;
}

function makeBundle(overrides?: (b: VerificationBundleV1) => void): VerificationBundleV1 {
  const b: VerificationBundleV1 = {
    schemaVersion: "1",
    projectId: "prj_thwip",
    repositoryId: "1315419165",
    ownerId: "162603603",
    activePolicyDigest: POLICY_DIGEST,
    gracePolicyDigests: [],
    policy: {
      schemaVersion: "1",
      projectId: "prj_thwip",
      repositoryId: "1315419165",
      ownerId: "162603603",
      version: 1,
      securityProfile: "fast",
      minimumPermission: "write",
      allowAuthorAsSigner: true,
      evaluationMode: "head-tree",
      allowedKeyAlgorithms: ["ssh-ed25519"],
      requireGithubKeyPresence: false,
      lease: { required: false, maxAgeSeconds: 1800 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command", requiredSuites: ["lint", "typecheck", "test"] },
      proofMaxAgeSeconds: 86400,
      audit: { basisPoints: 0, mandatoryPaths: [] },
    },
    keys: [
      {
        keyId: "key_test1",
        githubUserId: "264261678",
        algorithm: "ssh-ed25519",
        publicKey: "ssh-ed25519 AAAATESTKEY",
        revokedAt: null,
      },
    ],
    grants: [{ githubUserId: "264261678", permission: "admin", active: true }],
    leaseIssuerJwks: [],
    issuedAt: NOW,
    expiresAt: "2026-07-28T12:05:00Z",
  };
  overrides?.(b);
  return b;
}

function makeFacts(overrides?: Partial<GithubFacts>): GithubFacts {
  return {
    ownerId: "162603603",
    repositoryId: "1315419165",
    headSha: "d".repeat(40),
    treeOid: TREE,
    parentOids: [PARENT],
    baseRef: "refs/heads/main",
    baseSha: BASE,
    objectFormat: "sha1",
    ...overrides,
  };
}

const deps: VerifyDeps = {
  verifySshSignature: async ({ signatureBase64 }) => signatureBase64 === "GOOD",
};

async function run(args?: {
  statement?: InTotoStatementV1;
  envelope?: DsseEnvelope;
  message?: string;
  bundle?: VerificationBundleV1;
  facts?: GithubFacts;
  now?: string;
}) {
  const statement = args?.statement ?? makeStatement();
  const envelope = args?.envelope ?? envelopeFor(statement);
  const message = args?.message ?? commitMessageFor(envelope);
  return verifyProof(
    {
      commitMessage: message,
      facts: args?.facts ?? makeFacts(),
      bundle: args?.bundle ?? makeBundle(),
      now: args?.now ?? NOW,
    },
    deps,
  );
}

describe("verifyProof decision table", () => {
  it("passes a valid exact-subject proof", async () => {
    const r = await run();
    expect(r.code).toBe("PASS");
  });

  it("fails with no trailer", async () => {
    expect((await run({ message: "feat: nothing here\n" })).code).toBe("PROOF_MISSING");
  });

  it("fails with duplicate trailers", async () => {
    const env = envelopeFor(makeStatement());
    const line = encodeCarrier(env);
    expect((await run({ message: `x\n\n${line}\n${line}\n` })).code).toBe("PROOF_DUPLICATE");
  });

  it("fails on unknown carrier version", async () => {
    expect((await run({ message: "x\n\nthwip-proof: v9.abcd\n" })).code).toBe("PROOF_SCHEMA_UNSUPPORTED");
  });

  it("fails on bad signature", async () => {
    const env = envelopeFor(makeStatement(), "BAD");
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SIGNATURE_INVALID");
  });

  it("fails on unknown signer key", async () => {
    const env = envelopeFor(makeStatement(), "GOOD", "key_other");
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SIGNER_KEY_UNKNOWN");
  });

  it("fails on revoked key", async () => {
    const bundle = makeBundle((b) => {
      b.keys[0]!.revokedAt = "2026-07-28T10:00:00Z";
    });
    expect((await run({ bundle })).code).toBe("SIGNER_KEY_REVOKED");
  });

  it("fails on forbidden algorithm", async () => {
    const bundle = makeBundle((b) => {
      b.policy.allowedKeyAlgorithms = ["sk-ssh-ed25519@openssh.com"];
    });
    expect((await run({ bundle })).code).toBe("SIGNER_KEY_ALGORITHM_FORBIDDEN");
  });

  it("fails when proof is copied to another repository", async () => {
    const facts = makeFacts({ repositoryId: "999", ownerId: "888" });
    const bundle = makeBundle((b) => {
      b.repositoryId = "999";
      b.ownerId = "888";
    });
    expect((await run({ facts, bundle })).code).toBe("SUBJECT_REPOSITORY_MISMATCH");
  });

  it("fails when the tree differs (different code)", async () => {
    expect((await run({ facts: makeFacts({ treeOid: "e".repeat(40) }) })).code).toBe("SUBJECT_TREE_MISMATCH");
  });

  it("fails on ancestry mismatch (rebase/cherry-pick)", async () => {
    expect((await run({ facts: makeFacts({ parentOids: ["f".repeat(40)] }) })).code).toBe("SUBJECT_ANCESTRY_MISMATCH");
  });

  it("fails when base advanced", async () => {
    expect((await run({ facts: makeFacts({ baseSha: "9".repeat(40) }) })).code).toBe("SUBJECT_BASE_MISMATCH");
  });

  it("fails on retired policy digest", async () => {
    const bundle = makeBundle((b) => {
      b.activePolicyDigest = `sha256:${"7".repeat(64)}`;
    });
    expect((await run({ bundle })).code).toBe("POLICY_NOT_ACTIVE");
  });

  it("passes on grace-eligible previous policy", async () => {
    const bundle = makeBundle((b) => {
      b.activePolicyDigest = `sha256:${"7".repeat(64)}`;
      b.gracePolicyDigests = [POLICY_DIGEST];
    });
    expect((await run({ bundle })).code).toBe("PASS");
  });

  it("fails on pipeline digest mismatch", async () => {
    const bundle = makeBundle((b) => {
      b.policy.pipeline.digest = `sha256:${"8".repeat(64)}`;
    });
    expect((await run({ bundle })).code).toBe("PIPELINE_DIGEST_MISMATCH");
  });

  it("fails when predicate signer disagrees with envelope key", async () => {
    const statement = makeStatement((s) => {
      s.predicate.signer.keyId = "key_other";
    });
    const env = envelopeFor(statement);
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SIGNER_MISMATCH");
  });

  it("fails when signer lost repository permission", async () => {
    const bundle = makeBundle((b) => {
      b.grants = [{ githubUserId: "264261678", permission: "read", active: true }];
    });
    expect((await run({ bundle })).code).toBe("SIGNER_PERMISSION_INSUFFICIENT");
  });

  it("fails when signer was removed", async () => {
    const bundle = makeBundle((b) => {
      b.grants = [{ githubUserId: "264261678", permission: "admin", active: false }];
    });
    expect((await run({ bundle })).code).toBe("SIGNER_PERMISSION_INSUFFICIENT");
  });

  it("fails when author-as-signer is forbidden and author signed", async () => {
    const bundle = makeBundle((b) => {
      b.policy.allowAuthorAsSigner = false;
    });
    const facts = makeFacts({ prAuthorGithubUserId: "264261678" });
    expect((await run({ bundle, facts })).code).toBe("SIGNER_PERMISSION_INSUFFICIENT");
  });

  it("fails when a required suite is missing", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.suites = s.predicate.run.suites.filter((x) => x.id !== "test");
    });
    const env = envelopeFor(statement);
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SUITE_MISSING");
  });

  it("fails when a required suite did not pass", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.suites[2]!.status = "failed";
    });
    const env = envelopeFor(statement);
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SUITE_NOT_PASSED");
  });

  it("fails on duplicate suite ids", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.suites.push({ id: "lint", status: "passed", durationMs: 1 });
    });
    const env = envelopeFor(statement);
    expect((await run({ envelope: env, message: commitMessageFor(env) })).code).toBe("SUITE_DUPLICATE");
  });

  it("fails when the proof is older than policy allows", async () => {
    expect((await run({ now: "2026-07-30T12:00:01Z" })).code).toBe("BUNDLE_EXPIRED");
    const bundle = makeBundle((b) => {
      b.expiresAt = "2026-07-30T13:00:00Z";
    });
    expect((await run({ now: "2026-07-30T12:00:01Z", bundle })).code).toBe("PROOF_EXPIRED");
  });

  it("fails when lease is required but absent", async () => {
    const bundle = makeBundle((b) => {
      b.policy.lease.required = true;
    });
    expect((await run({ bundle })).code).toBe("LEASE_REQUIRED");
  });

  it("fails on expired bundle", async () => {
    expect((await run({ now: "2026-07-28T12:06:00Z" })).code).toBe("BUNDLE_EXPIRED");
  });
});

describe("hybrid: remote suites proven by GitHub", () => {
  const withRemote = () =>
    makeBundle((b) => {
      b.policy.pipeline.remoteSuites = ["build-darwin"];
    });

  it("passes when the remote suite's check succeeded on this commit", async () => {
    const r = await verifyProof(
      {
        commitMessage: commitMessageFor(envelopeFor(makeStatement())),
        facts: makeFacts(),
        bundle: withRemote(),
        now: NOW,
      },
      {
        ...deps,
        remoteCheckConclusions: async () => new Map([["thwip / build-darwin", "success"]]),
      },
    );
    expect(r.code).toBe("PASS");
  });

  it("fails when the remote suite has no check on this commit", async () => {
    const r = await verifyProof(
      {
        commitMessage: commitMessageFor(envelopeFor(makeStatement())),
        facts: makeFacts(),
        bundle: withRemote(),
        now: NOW,
      },
      { ...deps, remoteCheckConclusions: async () => new Map() },
    );
    expect(r.code).toBe("SUITE_MISSING");
  });

  it("fails when the remote suite's check failed", async () => {
    const r = await verifyProof(
      {
        commitMessage: commitMessageFor(envelopeFor(makeStatement())),
        facts: makeFacts(),
        bundle: withRemote(),
        now: NOW,
      },
      { ...deps, remoteCheckConclusions: async () => new Map([["build-darwin", "failure"]]) },
    );
    expect(r.code).toBe("SUITE_NOT_PASSED");
  });
});

// --- Lease, merge tree, key presence and audit ------------------------------

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

/** A lease shaped like the one `/v1/run-leases` mints. `sig` decides the fake signature. */
function makeLease(claims?: Record<string, unknown>, header?: Record<string, unknown>, sig = "GOOD"): string {
  const payload = {
    aud: "urn:thwip:ci-run:v1",
    iss: "https://thwip.recall.net",
    repositoryId: "1315419165",
    treeOid: TREE,
    parentOids: [PARENT],
    baseSha: BASE,
    policyDigest: POLICY_DIGEST,
    deviceKeyId: "key_test1",
    profile: "fresh",
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 1740,
    ...claims,
  };
  return `${b64url(JSON.stringify({ alg: "ES256", kid: "svc1", ...header }))}.${b64url(JSON.stringify(payload))}.${b64url(sig)}`;
}

const leaseDeps: VerifyDeps = {
  ...deps,
  verifyLeaseSignature: async ({ signingInput, signature }) =>
    signingInput.length > 0 && Buffer.from(signature).toString("utf8") === "GOOD",
};

function leasePolicy(b: VerificationBundleV1, maxAgeSeconds = 1800): void {
  b.policy.securityProfile = "fresh";
  b.policy.lease = { required: true, maxAgeSeconds };
  b.leaseIssuerJwks = [{ kty: "EC", crv: "P-256", kid: "svc1", x: "x", y: "y" }];
}

async function runWith(
  overrides: {
    statement?: InTotoStatementV1;
    bundle?: VerificationBundleV1;
    facts?: GithubFacts;
    now?: string;
  },
  withDeps: VerifyDeps,
) {
  const statement = overrides.statement ?? makeStatement();
  return verifyProof(
    {
      commitMessage: commitMessageFor(envelopeFor(statement)),
      facts: overrides.facts ?? makeFacts(),
      bundle: overrides.bundle ?? makeBundle(),
      now: overrides.now ?? NOW,
    },
    withDeps,
  );
}

describe("run leases", () => {
  const leaseStatement = (lease: string): InTotoStatementV1 =>
    makeStatement((s) => {
      s.predicate.run.lease = lease;
    });

  it("passes a lease signed by the issuer, in date, and bound to this run", async () => {
    const r = await runWith({ statement: leaseStatement(makeLease()), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("PASS");
  });

  it("refuses a proof with no lease when the policy requires one", async () => {
    const r = await runWith({ bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_REQUIRED");
  });

  it("refuses a lease the issuer did not sign", async () => {
    const lease = makeLease(undefined, undefined, "FORGED");
    const r = await runWith({ statement: leaseStatement(lease), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_INVALID");
  });

  it("refuses a lease when the project has no issuer keys", async () => {
    const bundle = makeBundle((b) => {
      leasePolicy(b);
      b.leaseIssuerJwks = [];
    });
    const r = await runWith({ statement: leaseStatement(makeLease()), bundle }, leaseDeps);
    expect(r.code).toBe("LEASE_INVALID");
  });

  it("refuses a lease when nothing can check lease signatures", async () => {
    const r = await runWith({ statement: leaseStatement(makeLease()), bundle: makeBundle(leasePolicy) }, deps);
    expect(r.code).toBe("LEASE_INVALID");
  });

  it("refuses a lease older than the policy window", async () => {
    const lease = makeLease({ iat: NOW_SECONDS - 3600, exp: NOW_SECONDS + 600 });
    const r = await runWith(
      { statement: leaseStatement(lease), bundle: makeBundle((b) => leasePolicy(b, 60)) },
      leaseDeps,
    );
    expect(r.code).toBe("LEASE_EXPIRED");
  });

  it("refuses a lease that has run out", async () => {
    const lease = makeLease({ exp: NOW_SECONDS - 1 });
    const r = await runWith({ statement: leaseStatement(lease), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_EXPIRED");
  });

  it("refuses a lease minted after the run it claims to cover", async () => {
    // Run once, then mint a fresh lease to keep the old evidence alive.
    const lease = makeLease({ iat: NOW_SECONDS - 10, nbf: NOW_SECONDS - 10 });
    const statement = makeStatement((s) => {
      s.predicate.run.lease = lease;
      s.predicate.run.startedAt = "2026-07-28T11:00:00Z";
      s.predicate.run.finishedAt = "2026-07-28T11:30:00Z";
    });
    const r = await runWith({ statement, bundle: makeBundle((b) => leasePolicy(b, 3600)) }, leaseDeps);
    expect(r.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("refuses a valid lease minted for another tree", async () => {
    const lease = makeLease({ treeOid: "9".repeat(40) });
    const r = await runWith({ statement: leaseStatement(lease), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("refuses a valid lease minted for another repository", async () => {
    const lease = makeLease({ repositoryId: "999" });
    const r = await runWith({ statement: leaseStatement(lease), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("refuses a valid lease minted for another device", async () => {
    const lease = makeLease({ deviceKeyId: "key_someone_else" });
    const r = await runWith({ statement: leaseStatement(lease), bundle: makeBundle(leasePolicy) }, leaseDeps);
    expect(r.code).toBe("LEASE_CONTEXT_MISMATCH");
  });

  it("ignores a lease the policy does not require", async () => {
    const r = await runWith({ statement: leaseStatement("not-a-lease") }, deps);
    expect(r.code).toBe("PASS");
  });
});

describe("merge-tree evaluation", () => {
  const MERGE = "e".repeat(40);
  const mergeBundle = () =>
    makeBundle((b) => {
      b.policy.evaluationMode = "merge-tree";
    });
  const mergeStatement = (mergeTreeOid?: string) =>
    makeStatement((s) => {
      s.predicate.git.evaluationMode = "merge-tree";
      if (mergeTreeOid !== undefined) s.predicate.git.mergeTreeOid = mergeTreeOid;
    });

  it("passes when the proof names the merge GitHub computes", async () => {
    const r = await runWith(
      { statement: mergeStatement(MERGE), bundle: mergeBundle(), facts: makeFacts({ mergeTreeOid: MERGE }) },
      deps,
    );
    expect(r.code).toBe("PASS");
  });

  it("refuses a proof that names a different merge tree", async () => {
    const r = await runWith(
      { statement: mergeStatement("f".repeat(40)), bundle: mergeBundle(), facts: makeFacts({ mergeTreeOid: MERGE }) },
      deps,
    );
    expect(r.code).toBe("SUBJECT_TREE_MISMATCH");
  });

  it("refuses a proof that names no merge tree", async () => {
    const r = await runWith(
      { statement: mergeStatement(), bundle: mergeBundle(), facts: makeFacts({ mergeTreeOid: MERGE }) },
      deps,
    );
    expect(r.code).toBe("SUBJECT_TREE_MISMATCH");
  });

  it("refuses when the merge GitHub computes is unavailable", async () => {
    const r = await runWith({ statement: mergeStatement(MERGE), bundle: mergeBundle() }, deps);
    expect(r.code).toBe("SUBJECT_TREE_MISMATCH");
  });

  it("leaves head-tree projects alone", async () => {
    expect((await runWith({}, deps)).code).toBe("PASS");
  });
});

describe("requireGithubKeyPresence", () => {
  const strict = () =>
    makeBundle((b) => {
      b.policy.requireGithubKeyPresence = true;
    });

  it("passes when GitHub publishes the enrolled key", async () => {
    const r = await runWith(
      { bundle: strict() },
      { ...deps, githubUserSigningKeys: async () => ["ssh-ed25519 AAAATESTKEY andrew@laptop"] },
    );
    expect(r.code).toBe("PASS");
  });

  it("refuses when GitHub publishes other keys", async () => {
    const r = await runWith({ bundle: strict() }, { ...deps, githubUserSigningKeys: async () => ["ssh-ed25519 AAAAOTHER"] });
    expect(r.code).toBe("SIGNER_KEY_UNKNOWN");
  });

  it("refuses when nothing can read the signer's GitHub keys", async () => {
    expect((await runWith({ bundle: strict() }, deps)).code).toBe("SIGNER_KEY_UNKNOWN");
  });
});

describe("audit", () => {
  const audited = (basisPoints: number, mandatoryPaths: string[] = []) =>
    makeBundle((b) => {
      b.policy.securityProfile = "audited";
      b.policy.audit = { basisPoints, mandatoryPaths };
    });

  it("audits nothing when the rate is zero and no paths are protected", async () => {
    expect((await runWith({ bundle: audited(0) }, deps)).code).toBe("PASS");
  });

  it("refuses when every proof is audited and no auditor is available", async () => {
    expect((await runWith({ bundle: audited(10_000) }, deps)).code).toBe("AUDIT_REQUIRED");
  });

  it("passes when the audit re-run agrees", async () => {
    const r = await runWith({ bundle: audited(10_000) }, { ...deps, auditProof: async () => ({ agrees: true }) });
    expect(r.code).toBe("PASS");
  });

  it("refuses when the audit re-run disagrees", async () => {
    const r = await runWith(
      { bundle: audited(10_000) },
      { ...deps, auditProof: async () => ({ agrees: false, detail: "test failed on re-run" }) },
    );
    expect(r.code).toBe("AUDIT_DISAGREED");
  });

  it("audits a change under a protected path whatever the sampling rate", async () => {
    const r = await runWith(
      { bundle: audited(0, ["infra/"]), facts: makeFacts({ changedPaths: ["infra/deploy.tf"] }) },
      deps,
    );
    expect(r.code).toBe("AUDIT_REQUIRED");
  });

  it("leaves a change outside the protected paths alone", async () => {
    const r = await runWith({ bundle: audited(0, ["infra/"]), facts: makeFacts({ changedPaths: ["src/app.ts"] }) }, deps);
    expect(r.code).toBe("PASS");
  });

  it("refuses when the protected paths cannot be compared to the change", async () => {
    expect((await runWith({ bundle: audited(0, ["infra/"]) }, deps)).code).toBe("AUDIT_REQUIRED");
  });
});
