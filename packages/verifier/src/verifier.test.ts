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
