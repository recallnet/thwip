import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet } from "jose";
import { canonicalRecordBytes, envelopeDigest } from "@thwip/queue-protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { runFreshTurn, type FreshTurnPorts } from "./fresh-turn.js";
import type { CandidateWorkspace } from "./candidate.js";
import type { SignedReceipt } from "./receipt.js";

/**
 * The turn end to end, with every refusal wired to the step that must not have
 * happened. Two of these are the whole reason the file exists: a turn that
 * fails to verify must run nothing, and the receipt must report the tree the
 * assignment signed.
 */

const D = (label: string) => `sha256:${(label.charCodeAt(0) % 10).toString().repeat(64)}`;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE_SHA = "3".repeat(40);
const CANDIDATE_TREE = "4".repeat(40);
const DEVICE = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function assignmentRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    assignmentId: "asg-1",
    attemptId: "att-1",
    repository: { ownerId: "162603603", repositoryId: "1315419165", baseRef: "refs/heads/main" },
    queue: {
      queueEpoch: 0,
      turnSequence: 5,
      entryId: "entry-1",
      pullRequestNumber: 42,
      sponsorPrincipalId: "alice",
      queueDecisionDigest: D("d"),
    },
    execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: DEVICE },
    git: {
      objectFormat: "sha1",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      baseSha: BASE,
      headRepositoryId: "1315419165",
      headSha: HEAD,
      candidateSha: CANDIDATE_SHA,
      candidateTreeOid: CANDIDATE_TREE,
      candidateParentOids: [BASE, HEAD],
    },
    policy: {
      digest: D("p"),
      version: 4,
      securityProfile: "fresh",
      runner: "command",
      requiredSuites: ["lint", "test"],
    },
    evidence: { workReceiptDigest: D("w"), previousTransitionDigest: D("t") },
    timing: {
      issuedAt: "2026-07-29T12:00:00Z",
      notBefore: "2026-07-29T12:00:00Z",
      expiresAt: "2026-07-29T12:20:00Z",
    },
    nonce: "nonce-1",
    ...over,
  };
}

let jwks: JSONWebKeySet;
let sign: (record: unknown) => Promise<string>;
let signAsImpostor: (record: unknown) => Promise<string>;

beforeAll(async () => {
  const service = await generateKeyPair("ES256", { extractable: true });
  const impostor = await generateKeyPair("ES256", { extractable: true });
  jwks = { keys: [{ ...(await exportJWK(service.publicKey)), alg: "ES256", kid: "svc" }] };
  sign = (record) =>
    new CompactSign(canonicalRecordBytes(record)).setProtectedHeader({ alg: "ES256", kid: "svc" }).sign(service.privateKey);
  signAsImpostor = (record) =>
    new CompactSign(canonicalRecordBytes(record))
      .setProtectedHeader({ alg: "ES256", kid: "x" })
      .sign(impostor.privateKey);
});

interface Trace {
  materialized: Array<{ candidateSha: string; candidateTreeOid: string }>;
  ranIn: string[];
  submitted: SignedReceipt[];
  disposed: number;
}

async function claimBody(
  over: Record<string, unknown> = {},
  record = assignmentRecord(),
  signer = sign,
): Promise<unknown> {
  return {
    assignmentId: "asg-1",
    assignmentDigest: await envelopeDigest(canonicalRecordBytes(record)),
    assignment: await signer(record),
    candidateSha: CANDIDATE_SHA,
    candidateTreeOid: CANDIDATE_TREE,
    requiredSuites: ["lint", "test"],
    executionSeconds: 900,
    ...over,
  };
}

function ports(
  trace: Trace,
  over: Partial<FreshTurnPorts> = {},
  claim?: () => Promise<{ status: number; body: unknown }>,
): FreshTurnPorts {
  const workspace: CandidateWorkspace = {
    dir: "/tmp/candidate-workspace",
    candidateSha: CANDIDATE_SHA,
    treeOid: CANDIDATE_TREE,
    dispose: async () => {
      trace.disposed += 1;
    },
  };
  return {
    claim: claim ?? (async () => ({ status: 200, body: await claimBody() })),
    publishedKeys: async () => jwks,
    async materialize(input) {
      trace.materialized.push(input);
      return { ok: true, workspace };
    },
    async runSuites(space, suites) {
      trace.ranIn.push(space.dir);
      return suites.map((name) => ({ name, outcome: "passed" as const }));
    },
    async signReceipt(receipt) {
      return { ...receipt, signature: "signed-by-the-device" };
    },
    async submit(receipt) {
      trace.submitted.push(receipt);
      return { status: 200, body: { accepted: true } };
    },
    now: () => "2026-07-29T12:05:00Z",
    ...over,
  };
}

function tracer(): Trace {
  return { materialized: [], ranIn: [], submitted: [], disposed: 0 };
}

const context = { deviceKeyId: DEVICE, repositoryId: "1315419165", attemptId: "att-1" };

describe("runFreshTurn", () => {
  it("claims, runs the candidate, and submits a receipt the assignment decides the contents of", async () => {
    const trace = tracer();
    const result = await runFreshTurn(context, ports(trace));

    expect(result).toMatchObject({ ok: true });
    expect(trace.materialized).toEqual([{ candidateSha: CANDIDATE_SHA, candidateTreeOid: CANDIDATE_TREE }]);
    expect(trace.ranIn).toEqual(["/tmp/candidate-workspace"]);
    expect(trace.submitted).toHaveLength(1);
    expect(trace.submitted[0]).toMatchObject({
      assignmentId: "asg-1",
      candidateTreeOid: CANDIDATE_TREE,
      deviceKeyId: DEVICE,
      signature: "signed-by-the-device",
      suites: [
        { name: "lint", outcome: "passed" },
        { name: "test", outcome: "passed" },
      ],
    });
    expect(trace.disposed).toBe(1);
  });

  it("runs nothing at all when the assignment is not signed by a key thwip publishes", async () => {
    const trace = tracer();
    const record = assignmentRecord();
    const result = await runFreshTurn(
      context,
      ports(trace, {}, async () => ({ status: 200, body: await claimBody({}, record, signAsImpostor) })),
    );

    expect(result).toMatchObject({ ok: false, reasonCode: "ASSIGNMENT_UNVERIFIED" });
    expect(trace.materialized).toEqual([]);
    expect(trace.ranIn).toEqual([]);
    expect(trace.submitted).toEqual([]);
  });

  it("never materializes a tree the signed assignment does not name", async () => {
    const trace = tracer();
    const result = await runFreshTurn(
      context,
      ports(trace, {}, async () => ({ status: 200, body: await claimBody({ candidateTreeOid: "7".repeat(40) }) })),
    );

    expect(result).toMatchObject({ ok: false, reasonCode: "CANDIDATE_TREE_MISMATCH" });
    expect(trace.materialized).toEqual([]);
    expect(trace.ranIn).toEqual([]);
  });

  it("reports the suites that actually ran, failures included", async () => {
    const trace = tracer();
    const result = await runFreshTurn(
      context,
      ports(trace, {
        async runSuites(space, suites) {
          trace.ranIn.push(space.dir);
          return suites.map((name) => ({ name, outcome: name === "test" ? ("failed" as const) : ("passed" as const) }));
        },
        async submit(receipt) {
          trace.submitted.push(receipt);
          return { status: 409, body: { reason: "SUITE_FAILED" } };
        },
      }),
    );

    expect(trace.submitted[0]?.suites).toEqual([
      { name: "lint", outcome: "passed" },
      { name: "test", outcome: "failed" },
    ]);
    expect(result).toMatchObject({ ok: false, reasonCode: "SUITE_FAILED" });
  });

  it("hands back the refusal the service gave, so the developer reads one story", async () => {
    const trace = tracer();
    const result = await runFreshTurn(
      context,
      ports(trace, {
        async submit(receipt) {
          trace.submitted.push(receipt);
          return { status: 409, body: { reason: "ASSIGNMENT_MISMATCH" } };
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reasonCode: "ASSIGNMENT_MISMATCH" });
    expect(trace.disposed).toBe(1);
  });

  it("takes the candidate off the disk however the turn ends", async () => {
    const trace = tracer();
    await runFreshTurn(
      context,
      ports(trace, {
        async runSuites() {
          throw new Error("the pipeline blew up");
        },
      }),
    ).catch(() => undefined);
    expect(trace.disposed).toBe(1);
  });

  it("reports a refused claim without inventing a reason for it", async () => {
    const trace = tracer();
    const result = await runFreshTurn(
      context,
      ports(trace, {}, async () => ({ status: 409, body: { reason: "DEVICE_MISMATCH" } })),
    );
    expect(result).toMatchObject({ ok: false, reasonCode: "DEVICE_MISMATCH" });
    expect(trace.materialized).toEqual([]);
  });

  it("treats an unreachable key set as a reason to wait, not as a forged assignment", async () => {
    const trace = tracer();
    const result = await runFreshTurn(context, ports(trace, { publishedKeys: async () => null }));
    expect(result).toMatchObject({ ok: false, reasonCode: "SERVICE_UNAVAILABLE" });
    expect(trace.materialized).toEqual([]);
  });

  it("stops when the candidate cannot be put on disk", async () => {
    const trace = tracer();
    const result = await runFreshTurn(
      context,
      ports(trace, {
        async materialize(input) {
          trace.materialized.push(input);
          return { ok: false, reasonCode: "CANDIDATE_UNAVAILABLE", detail: "origin has never heard of it" };
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reasonCode: "CANDIDATE_UNAVAILABLE" });
    expect(trace.ranIn).toEqual([]);
    expect(trace.submitted).toEqual([]);
  });
});
