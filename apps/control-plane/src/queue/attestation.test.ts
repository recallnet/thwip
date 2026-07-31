import { parseMergeIntent, parseTransitionRecord, envelopeDigest } from "@thwip/queue-protocol";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { readAttestation, signReusedIntent, signReusedRecord, storeAttestation } from "./attestation.js";
import type { D1Like } from "./projection.js";

/**
 * The records behind a chain link.
 *
 * A link used to be the merge commit id padded out to look like a digest, which
 * named the commit and attested to nothing. These are the bytes the queue signs,
 * and the point of each test below is that what gets signed is true: the schemas
 * refuse to carry a verifier result or an assignment, because under this profile
 * nothing ran against the integrated candidate and nothing was dispatched.
 */

const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

const git: GitSubject = {
  objectFormat: "sha1",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
  baseSha: BASE,
  headRepositoryId: "1315419165",
  headSha: HEAD,
  candidateSha: CANDIDATE,
  candidateTreeOid: TREE,
  candidateParentOids: [BASE, HEAD],
};

const evidence = {
  workReceiptDigest: D("a"),
  policyDigest: D("b"),
  pipelineDigest: D("c"),
  requiredSuitesDigest: D("d"),
  proofCheckRunId: "778899",
};

const position = {
  queueEpoch: 1,
  turnSequence: 4,
  transitionSequence: 9,
  previousTransitionDigest: D("e"),
};

/** Deterministic, so a digest can be compared rather than merely inspected. */
const signer = {
  async sign(bytes: Uint8Array) {
    return `jws.${await envelopeDigest(bytes)}`;
  },
};

async function intent() {
  const signed = await signReusedIntent({
    operationId: "merge_att-1",
    attemptId: "att-1",
    git,
    position,
    pullRequestNumber: 82,
    evidence,
    createdAt: "2026-07-31T12:00:00Z",
    signer,
  });
  if ("error" in signed) throw new Error(signed.error);
  return signed;
}

async function record(mergeIntentDigest: Sha256) {
  const signed = await signReusedRecord({
    attemptId: "att-1",
    git,
    position,
    pullRequestNumber: 82,
    evidence,
    mergeIntentDigest,
    before: { baseSha: BASE, treeOid: "5".repeat(40) },
    final: { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD] },
    observedAt: "2026-07-31T12:01:00Z",
    signer,
  });
  if ("error" in signed) throw new Error(signed.error);
  return signed;
}

describe("the merge intent the queue signs", () => {
  it("parses as a reused intent, so what was signed is what a verifier will accept", async () => {
    const signed = await intent();
    const parsed = parseMergeIntent(JSON.parse(new TextDecoder().decode(signed.bytes)));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("reused");
  });

  it("binds the developer's proof and the suites it had to satisfy", async () => {
    const signed = await intent();
    const parsed = parseMergeIntent(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok || parsed.value.kind !== "reused") throw new Error("expected a reused intent");
    expect(parsed.value.evidence.workReceiptDigest).toBe(evidence.workReceiptDigest);
    expect(parsed.value.evidence.requiredSuitesDigest).toBe(evidence.requiredSuitesDigest);
    expect(parsed.value.evidence.proofCheckRunId).toBe("778899");
  });

  /**
   * The intent says which commit the merge will produce. The workflow writes
   * exactly that commit, so this is a specification rather than a description.
   */
  it("specifies the commit the workflow is told to write", async () => {
    const signed = await intent();
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as { generatedCommitTitle: string };
    expect(doc.generatedCommitTitle).toBe("Merge pull request #82 (Thwip Queue)");
  });

  it("names the bytes it signed, so the digest is checkable", async () => {
    const signed = await intent();
    expect(signed.digest).toBe(await envelopeDigest(signed.bytes));
    expect(signed.jws).toBe(`jws.${signed.digest}`);
  });
});

describe("the transition record the queue signs", () => {
  it("parses as a reused-proof merge and cites the intent", async () => {
    const i = await intent();
    const signed = await record(i.digest);
    const parsed = parseTransitionRecord(JSON.parse(new TextDecoder().decode(signed.bytes)));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok || parsed.value.kind !== "reused-proof-merge") throw new Error("wrong kind");
    expect(parsed.value.reusedProof.mergeIntentDigest).toBe(i.digest);
    expect(parsed.value.reusedProof.workReceiptDigest).toBe(evidence.workReceiptDigest);
    expect(parsed.value.reusedProof.checkRunId).toBe("778899");
  });

  it("takes its place in the chain by naming the link before it", async () => {
    const signed = await record(D("f"));
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as {
      transitionSequence: number;
      previousTransitionDigest: string;
    };
    expect(doc.transitionSequence).toBe(9);
    expect(doc.previousTransitionDigest).toBe(D("e"));
  });

  /**
   * The whole reason the kind exists. If a record claiming an unrun verifier
   * could be built here, the signature would put the queue's name to it.
   */
  it("cannot be made to carry a verifier result or an assignment", async () => {
    const signed = await record(D("f"));
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as {
      reusedProof: Record<string, unknown>;
    };
    expect(doc.reusedProof).not.toHaveProperty("verifierResultDigest");
    expect(doc.reusedProof).not.toHaveProperty("assignmentDigest");
    expect(doc.reusedProof).not.toHaveProperty("integrationEvidenceDigest");
  });
});

/**
 * What this repository actually produces. Its profile has the queue dispatch a
 * verifier against the integrated candidate, so the merge is stronger than a
 * reuse and must not be recorded as one — a reader would otherwise see a weaker
 * claim than the one the queue is entitled to make.
 */
describe("a merge the candidate verifier ran for", () => {
  const verified = { ...evidence, verifierResultDigest: D("9") };

  async function verifiedRecord() {
    const signed = await signReusedRecord({
      attemptId: "att-1",
      git,
      position,
      pullRequestNumber: 82,
      evidence: verified,
      mergeIntentDigest: D("f"),
      before: { baseSha: BASE, treeOid: "5".repeat(40) },
      final: { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD] },
      observedAt: "2026-07-31T12:01:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    return signed;
  }

  it("is recorded as candidate-verified, not as a reuse", async () => {
    const signed = await verifiedRecord();
    const parsed = parseTransitionRecord(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.value.kind).toBe("candidate-verified-merge");
    if (parsed.value.kind !== "candidate-verified-merge") return;
    expect(parsed.value.candidateVerified.verifierResultDigest).toBe(D("9"));
  });

  /** The claims it still cannot make: nothing was assigned, no receipt exists. */
  it("names no assignment and no integration receipt", async () => {
    const signed = await verifiedRecord();
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as {
      candidateVerified: Record<string, unknown>;
    };
    expect(doc.candidateVerified).not.toHaveProperty("assignmentDigest");
    expect(doc.candidateVerified).not.toHaveProperty("integrationEvidenceDigest");
  });

  it("signs an intent that carries the verifier result too", async () => {
    const signed = await signReusedIntent({
      operationId: "merge_att-1",
      attemptId: "att-1",
      git,
      position,
      pullRequestNumber: 82,
      evidence: verified,
      createdAt: "2026-07-31T12:00:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    const parsed = parseMergeIntent(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok || parsed.value.kind !== "candidate-verified") throw new Error("wrong kind");
    expect(parsed.value.evidence.verifierResultDigest).toBe(D("9"));
  });
});

describe("keeping the signed bytes", () => {
  const open: Array<{ close(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });

  function db(): D1Like {
    const t = testD1();
    open.push(t);
    return t.db as unknown as D1Like;
  }

  it("gives back exactly what was signed", async () => {
    const store = db();
    const signed = await record(D("f"));
    await storeAttestation(store, {
      digest: signed.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: signed.bytes,
      jws: signed.jws,
    });

    const read = await readAttestation(store, signed.digest);
    expect(read?.jws).toBe(signed.jws);
    // Round-tripped through storage and still the same digest, which is the only
    // thing that makes the stored copy usable as evidence.
    const again = new TextEncoder().encode(JSON.stringify(read?.record));
    expect(await envelopeDigest(again)).toBe(signed.digest);
  });

  it("is nothing for a digest it never signed", async () => {
    expect(await readAttestation(db(), D("9"))).toBeNull();
  });

  /** Delivery is at-least-once, and a record is immutable once written. */
  it("stores the same record twice without complaint", async () => {
    const store = db();
    const signed = await record(D("f"));
    const row = {
      digest: signed.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: signed.bytes,
      jws: signed.jws,
    };
    await storeAttestation(store, row);
    await storeAttestation(store, row);
    expect(await readAttestation(store, signed.digest)).not.toBeNull();
  });
});
