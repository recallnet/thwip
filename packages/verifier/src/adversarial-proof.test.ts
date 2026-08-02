import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  REASON_CODES,
  STATEMENT_TYPE,
  b64stdEncode,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { verifyProof, type GithubFacts, type VerifyDeps } from "./index.js";

/**
 * ADVERSARIAL RECONNAISSANCE. Expected to FAIL against current behaviour, except
 * the block at the end, which records defences that already hold.
 */

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
      allowedKeyAlgorithms: ["ssh-ed25519"],
      lease: { required: false, maxAgeSeconds: 1800 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command", requiredSuites: ["lint", "typecheck", "test"] },
      proofMaxAgeSeconds: 86400,
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
  message?: string;
  bundle?: VerificationBundleV1;
  facts?: GithubFacts;
  now?: string;
}) {
  const statement = args?.statement ?? makeStatement();
  const message = args?.message ?? `feat: something\n\n${encodeCarrier(envelopeFor(statement))}\n`;
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

describe("ADVERSARIAL: what the proof gate does not check", () => {
  it("refuses a lease it cannot verify when the policy requires one", async () => {
    // The `fresh` and stronger profiles turn `lease.required` on. The verifier
    // only asks whether the field is present, so any string satisfies it, and
    // LEASE_INVALID / LEASE_EXPIRED / LEASE_CONTEXT_MISMATCH are never reachable.
    const bundle = makeBundle((b) => {
      b.policy.securityProfile = "fresh";
      b.policy.lease = { required: true, maxAgeSeconds: 60 };
    });
    const statement = makeStatement((s) => {
      s.predicate.run.lease = "not-a-lease-at-all";
    });
    const result = await run({ statement, bundle });
    expect(result.code, "a garbage lease was accepted as freshness evidence").not.toBe("PASS");
  });

  it("does not treat a lease minted long before the run as fresh", async () => {
    // `lease.maxAgeSeconds` is declared, stored, shipped in the bundle, and read
    // by nothing.
    const bundle = makeBundle((b) => {
      b.policy.lease = { required: true, maxAgeSeconds: 60 };
    });
    const statement = makeStatement((s) => {
      // A syntactically plausible lease token issued a year ago.
      s.predicate.run.lease = "eyJhbGciOiJFZERTQSJ9.eyJpYXQiOjE3MDAwMDAwMDB9.c2ln";
    });
    const result = await run({ statement, bundle });
    expect(result.code, "an ancient lease satisfied a 60-second freshness window").not.toBe("PASS");
  });

  it("refuses a proof that claims to have finished in the future", async () => {
    // `nowMs - finished > maxAge` can never be true for a future timestamp, so a
    // proof dated forward never expires. proofMaxAgeSeconds stops binding.
    const statement = makeStatement((s) => {
      s.predicate.run.startedAt = "2035-01-01T00:00:00Z";
      s.predicate.run.finishedAt = "2035-01-01T00:10:00Z";
    });
    const result = await run({ statement });
    expect(result.code, "a proof dated ten years forward never expires").not.toBe("PASS");
  });

  it("refuses a proof that finished before it started", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.startedAt = "2026-07-28T11:59:00Z";
      s.predicate.run.finishedAt = "2026-07-28T11:50:00Z";
    });
    const result = await run({ statement });
    expect(result.code).not.toBe("PASS");
  });

  it("refuses a proof that claims to cover something other than the head tree", async () => {
    // `merge-tree` was a second evaluation mode no derivation ever selected and
    // no signer could produce. A proof claiming it is a proof nothing judges.
    const statement = makeStatement((s) => {
      (s.predicate.git as { evaluationMode: string }).evaluationMode = "merge-tree";
    });
    const result = await run({ statement });
    expect(result.code, "a proof claiming an unsupported evaluation mode was accepted").not.toBe("PASS");
  });

  it("reads no policy field the policy derivation never writes", async () => {
    // The family this file exists to catch: a field the verifier branches on
    // that nothing populates reads as a control to whoever opens the policy and
    // decides nothing. Every field the verifier reads has to be one the
    // derivation sets.
    const [verifier, derivation] = await Promise.all(
      ["./index.ts", "../../policy/src/index.ts"].map(async (path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    const read = new Set([...verifier.matchAll(/bundle\.policy\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!));
    const unset = [...read].filter((field) => !derivation.includes(`${field}:`));
    expect(unset, `policy fields the verifier reads and nothing sets: ${unset.join(", ")}`).toEqual([]);
  });

  it("can emit every reason code the protocol declares", async () => {
    // A reason code nothing can produce is a promise the vocabulary makes and the
    // implementation does not keep. The Action publishes a check-run line reading
    // "Proof age and lease within policy" and lists LEASE_INVALID, LEASE_EXPIRED
    // and LEASE_CONTEXT_MISMATCH beside it, so a reader is told the lease was
    // checked against things no code ever checks.
    const sources = await Promise.all(
      [
        "./index.ts",
        "../../protocol/src/carrier.ts",
        "../../action/src/bundle-resolution.ts",
        "../../action/src/main.ts",
      ].map(async (path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    // Only a code used to *decide* counts. main.ts names some purely for display.
    const decisive = sources.slice(0, 3).join("\n") + sources[3]!.split("Proof age and lease")[0];
    const unreachable = REASON_CODES.filter((code) => !decisive.includes(code));
    expect(unreachable, `reason codes nothing can emit: ${unreachable.join(", ")}`).toEqual([]);
  });
});

describe("ADVERSARIAL: proof-path defences that already hold", () => {
  it("refuses a proof for another repository", async () => {
    const statement = makeStatement((s) => {
      s.predicate.repository.repositoryId = "999";
    });
    expect((await run({ statement })).code).toBe("SUBJECT_REPOSITORY_MISMATCH");
  });

  it("refuses a proof for another tree", async () => {
    expect((await run({ facts: makeFacts({ treeOid: "9".repeat(40) }) })).code).toBe("SUBJECT_TREE_MISMATCH");
  });

  it("refuses a proof taken from a different base", async () => {
    expect((await run({ facts: makeFacts({ baseSha: "9".repeat(40) }) })).code).toBe("SUBJECT_BASE_MISMATCH");
  });

  it("refuses a proof whose parents no longer match the commit (a rebase)", async () => {
    expect((await run({ facts: makeFacts({ parentOids: ["9".repeat(40)] }) })).code).toBe(
      "SUBJECT_ANCESTRY_MISMATCH",
    );
  });

  it("refuses a key revoked after the proof was signed", async () => {
    const bundle = makeBundle((b) => {
      b.keys[0]!.revokedAt = "2026-07-28T11:59:30Z";
    });
    expect((await run({ bundle })).code).toBe("SIGNER_KEY_REVOKED");
  });

  it("refuses a key that was never enrolled", async () => {
    const statement = makeStatement((s) => {
      s.predicate.signer.keyId = "key_stranger";
    });
    const message = `feat: x\n\n${encodeCarrier(envelopeFor(statement, "GOOD", "key_stranger"))}\n`;
    expect((await run({ statement, message })).code).toBe("SIGNER_KEY_UNKNOWN");
  });

  it("refuses a proof missing a required suite", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.suites = s.predicate.run.suites.filter((suite) => suite.id !== "test");
    });
    expect((await run({ statement })).code).toBe("SUITE_MISSING");
  });

  it("refuses a proof that ran the same suite twice", async () => {
    const statement = makeStatement((s) => {
      s.predicate.run.suites = [
        { id: "lint", status: "passed", durationMs: 1 },
        { id: "typecheck", status: "passed", durationMs: 1 },
        { id: "test", status: "failed", durationMs: 1 },
        { id: "test", status: "passed", durationMs: 1 },
      ];
    });
    expect((await run({ statement })).code).toBe("SUITE_DUPLICATE");
  });

  it("refuses two proofs in one commit message", async () => {
    const carrier = encodeCarrier(envelopeFor(makeStatement()));
    expect((await run({ message: `feat: x\n\n${carrier}\n${carrier}\n` })).code).toBe("PROOF_DUPLICATE");
  });

  it("refuses a truncated carrier", async () => {
    const carrier = encodeCarrier(envelopeFor(makeStatement()));
    expect((await run({ message: `feat: x\n\n${carrier.slice(0, carrier.length - 40)}\n` })).code).toBe(
      "PROOF_MALFORMED",
    );
  });

  it("refuses a proof whose policy digest is no longer active", async () => {
    const bundle = makeBundle((b) => {
      b.activePolicyDigest = `sha256:${"9".repeat(64)}`;
    });
    expect((await run({ bundle })).code).toBe("POLICY_NOT_ACTIVE");
  });

  it("refuses an expired proof", async () => {
    expect((await run({ now: "2026-07-30T12:00:00Z", bundle: makeBundle((b) => { b.expiresAt = "2026-07-31T00:00:00Z"; }) })).code).toBe(
      "PROOF_EXPIRED",
    );
  });
});
