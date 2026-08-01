import { parseMergeIntent, parseTransitionRecord, envelopeDigest } from "@thwip/queue-protocol";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import {
  readAttestation,
  readChain,
  signReusedIntent,
  signReusedRecord,
  signVerifiedIntent,
  signVerifiedRecord,
  storeAttestation,
  verifiedEvidenceFor,
} from "./attestation.js";
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
  organizationId: "org_1",
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
    mergeMethod: "merge",
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
    mergeMethod: "merge",
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
      mergeMethod: "merge",
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
      mergeMethod: "merge",
      createdAt: "2026-07-31T12:00:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    const parsed = parseMergeIntent(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok || parsed.value.kind !== "candidate-verified") throw new Error("wrong kind");
    expect(parsed.value.evidence.verifierResultDigest).toBe(D("9"));
  });
});

/**
 * The strongest kind, unreachable until an assignment and a signed receipt
 * existed to back it. It asserts three things happened — an assignment was
 * issued, the runner it was issued to signed a receipt back, and a verifier
 * produced a result — and a record built without one of those would be
 * signing a claim the queue cannot show.
 */
describe("a merge backed by an assignment and a signed receipt", () => {
  const verifiedEvidence = {
    workReceiptDigest: D("a"),
    organizationId: "org_1",
    policyDigest: D("b"),
    assignmentDigest: D("0"),
    integrationEvidenceDigest: D("1"),
    verifierResultDigest: D("2"),
    candidateCheckRunId: "990011",
    actionRunId: "123456",
  };

  async function verifiedIntent() {
    const signed = await signVerifiedIntent({
      operationId: "merge_att-1",
      attemptId: "att-1",
      git,
      position,
      pullRequestNumber: 82,
      evidence: verifiedEvidence,
      mergeMethod: "merge",
      createdAt: "2026-07-31T12:00:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    return signed;
  }

  async function verifiedRecord(mergeIntentDigest: Sha256) {
    const signed = await signVerifiedRecord({
      attemptId: "att-1",
      git,
      position,
      pullRequestNumber: 82,
      evidence: verifiedEvidence,
      mergeMethod: "merge",
      mergeIntentDigest,
      before: { baseSha: BASE, treeOid: "5".repeat(40) },
      final: { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD] },
      observedAt: "2026-07-31T12:01:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    return signed;
  }

  it("parses as a verified merge and binds all four extra digests", async () => {
    const i = await verifiedIntent();
    const signed = await verifiedRecord(i.digest);
    const parsed = parseTransitionRecord(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.value.kind).toBe("verified-merge");
    if (parsed.value.kind !== "verified-merge") return;
    expect(parsed.value.verifiedMerge.mergeIntentDigest).toBe(i.digest);
    expect(parsed.value.verifiedMerge.assignmentDigest).toBe(verifiedEvidence.assignmentDigest);
    expect(parsed.value.verifiedMerge.integrationEvidenceDigest).toBe(verifiedEvidence.integrationEvidenceDigest);
    expect(parsed.value.verifiedMerge.verifierResultDigest).toBe(verifiedEvidence.verifierResultDigest);
    expect(parsed.value.verifiedMerge.actionRunId).toBe(verifiedEvidence.actionRunId);
  });

  it("signs an intent that carries the same four digests", async () => {
    const signed = await verifiedIntent();
    const parsed = parseMergeIntent(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok || parsed.value.kind !== "verified") throw new Error("expected a verified intent");
    expect(parsed.value.evidence.assignmentDigest).toBe(verifiedEvidence.assignmentDigest);
    expect(parsed.value.evidence.integrationEvidenceDigest).toBe(verifiedEvidence.integrationEvidenceDigest);
    expect(parsed.value.evidence.verifierResultDigest).toBe(verifiedEvidence.verifierResultDigest);
  });

  it("gathers the evidence when all three facts are present", () => {
    const result = verifiedEvidenceFor({
      workReceiptDigest: verifiedEvidence.workReceiptDigest,
      organizationId: verifiedEvidence.organizationId,
      policyDigest: verifiedEvidence.policyDigest,
      assignmentDigest: verifiedEvidence.assignmentDigest,
      integrationEvidenceDigest: verifiedEvidence.integrationEvidenceDigest,
      verifierResultDigest: verifiedEvidence.verifierResultDigest,
      candidateCheckRunId: verifiedEvidence.candidateCheckRunId,
      actionRunId: verifiedEvidence.actionRunId,
    });
    expect(result).toEqual(verifiedEvidence);
  });

  it("refuses when no assignment was issued", () => {
    const result = verifiedEvidenceFor({
      workReceiptDigest: verifiedEvidence.workReceiptDigest,
      organizationId: verifiedEvidence.organizationId,
      policyDigest: verifiedEvidence.policyDigest,
      assignmentDigest: null,
      integrationEvidenceDigest: verifiedEvidence.integrationEvidenceDigest,
      verifierResultDigest: verifiedEvidence.verifierResultDigest,
      candidateCheckRunId: verifiedEvidence.candidateCheckRunId,
      actionRunId: verifiedEvidence.actionRunId,
    });
    expect(result).toEqual({ missing: "no assignment was issued for this attempt" });
  });

  it("refuses when no receipt was signed", () => {
    const result = verifiedEvidenceFor({
      workReceiptDigest: verifiedEvidence.workReceiptDigest,
      organizationId: verifiedEvidence.organizationId,
      policyDigest: verifiedEvidence.policyDigest,
      assignmentDigest: verifiedEvidence.assignmentDigest,
      integrationEvidenceDigest: null,
      verifierResultDigest: verifiedEvidence.verifierResultDigest,
      candidateCheckRunId: verifiedEvidence.candidateCheckRunId,
      actionRunId: verifiedEvidence.actionRunId,
    });
    expect(result).toEqual({ missing: "no integration receipt was signed for this attempt" });
  });

  it("refuses when no verifier result was produced", () => {
    const result = verifiedEvidenceFor({
      workReceiptDigest: verifiedEvidence.workReceiptDigest,
      organizationId: verifiedEvidence.organizationId,
      policyDigest: verifiedEvidence.policyDigest,
      assignmentDigest: verifiedEvidence.assignmentDigest,
      integrationEvidenceDigest: verifiedEvidence.integrationEvidenceDigest,
      verifierResultDigest: null,
      candidateCheckRunId: verifiedEvidence.candidateCheckRunId,
      actionRunId: verifiedEvidence.actionRunId,
    });
    expect(result).toEqual({ missing: "no verifier result was produced for this attempt" });
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

  /**
   * The residual race the previous commit left open: two simultaneous first
   * reports of the same merge can both find nothing recorded and both sign,
   * so the second insert reaches the database rather than being turned away
   * earlier by the attempt-id check. The index is what has to refuse it.
   */
  it("refuses a second record for an attempt that already holds a chain position", async () => {
    const store = db();
    const first = await record(D("f"));
    await storeAttestation(store, {
      digest: first.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: first.bytes,
      jws: first.jws,
    });

    // A second, independently-signed record for the same attempt and the
    // same chain position — a different digest, because a fresh `observedAt`
    // makes a fresh digest every time. Inserted directly, bypassing
    // `storeAttestation`'s recovery, to prove the constraint itself holds
    // rather than only the code that catches it.
    await expect(
      store
        .prepare(
          `INSERT INTO queue_attestations
             (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(D("f2"), "reused-proof-merge", "1315419165", "refs/heads/main", 9, "att-1", "{}", "j2")
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  /**
   * The outcome that constraint has to produce in practice: the caller does
   * not see the insert failure as an unhandled error, and it ends up with
   * the digest that actually holds the position rather than the one it just
   * signed and lost the race to store.
   */
  it("reports the record that won the race instead of throwing", async () => {
    const store = db();
    const first = await record(D("f"));
    const firstResult = await storeAttestation(store, {
      digest: first.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: first.bytes,
      jws: first.jws,
    });
    expect(firstResult).toEqual({ stored: true });

    const second = await record(D("f")); // same attempt, a distinct signature
    const secondResult = await storeAttestation(store, {
      digest: D("f2"),
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: second.bytes,
      jws: second.jws,
    });
    expect(secondResult).toEqual({ stored: false, digest: first.digest });

    // The record that lost the race was never persisted — reading it back by
    // its own digest finds nothing.
    expect(await readAttestation(store, D("f2"))).toBeNull();
    expect(await readAttestation(store, first.digest)).not.toBeNull();
  });

  /**
   * The loser is still a genuine signed record — the queue really did sign
   * it — and content-addressed storage puts it under its own digest, which
   * collides with nothing. So the mirror on the losing path carries the
   * loser's own digest and bytes, not the winner's, even though the caller
   * is handed back the winner's digest for the chain position.
   */
  it("mirrors the losing record under its own digest, not the winner's", async () => {
    const store = db();
    const first = await record(D("f"));
    await storeAttestation(store, {
      digest: first.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: first.bytes,
      jws: first.jws,
      organizationId: "org_1",
    });

    const second = await record(D("f")); // same attempt, a distinct signature
    const puts: Array<{ kind: string; digest: string; bytes: Uint8Array }> = [];
    const secondResult = await storeAttestation(store, {
      digest: D("f2"),
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: second.bytes,
      jws: second.jws,
      organizationId: "org_1",
      mirror: async (input) => void puts.push({ kind: input.kind, digest: input.digest, bytes: input.bytes }),
    });

    expect(secondResult).toEqual({ stored: false, digest: first.digest });
    expect(puts).toEqual([{ kind: "transition-record", digest: D("f2"), bytes: second.bytes }]);
  });

  it("hands back a whole branch's records in chain order", async () => {
    const store = db();
    const first = await record(D("f"));
    await storeAttestation(store, {
      digest: first.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: first.bytes,
      jws: first.jws,
    });
    await storeAttestation(store, {
      digest: D("e"),
      kind: "merge-intent",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: null,
      attemptId: "att-1",
      bytes: new TextEncoder().encode("{}"),
      jws: "j",
    });

    const chain = await readChain(store, "1315419165", "refs/heads/main");
    // Intents are cited by records; they are not links, so they are not returned.
    expect(chain).toHaveLength(1);
    expect(chain[0]?.digest).toBe(first.digest);
    expect(new TextDecoder().decode(chain[0]!.bytes)).toBe(new TextDecoder().decode(first.bytes));
  });

  it("mirrors the signed bytes into the bucket it is given", async () => {
    const store = db();
    const signed = await record(D("f"));
    const puts: Array<{ kind: string; digest: string }> = [];

    await storeAttestation(store, {
      digest: signed.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: signed.bytes,
      jws: signed.jws,
      mirror: async (input) => void puts.push({ kind: input.kind, digest: input.digest }),
      organizationId: "org_1",
    });

    expect(puts).toEqual([{ kind: "transition-record", digest: signed.digest }]);
  });

  /** A bucket that is down must never cost the record itself. */
  it("keeps the record when the mirror fails", async () => {
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
      organizationId: "org_1",
      mirror: async () => {
        throw new Error("bucket unavailable");
      },
    });
    expect(await readAttestation(store, signed.digest)).not.toBeNull();
  });
});
