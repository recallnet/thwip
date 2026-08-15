import { describe, expect, it } from "vitest";
import { canonicalBytes, envelopeDigest } from "./canonical.js";
import { parseTransitionRecord } from "./transition-record.js";
import { verifyChain, type ChainLink } from "./verify-chain.js";

/**
 * Correcting a record without rewriting it.
 *
 * This fixture says a merge left the base at
 * `ff6ea882feefd64c4e9f4dff909209e7adb281e3`. That commit is the throwaway test
 * merge GitHub computes for an open pull request. It is on no branch and never
 * was. Main became `0b2076107aa20f8b365d3b510de4838b05d12622`, which carries the
 * same tree and the same parents in the same order.
 *
 * The bytes cannot change. The record's digest is its successor's predecessor and
 * five more records chain from it, so editing it means re-signing seven records
 * under new digests, which replaces the chain rather than repairing it.
 *
 * So the correction is appended: a signed record that names the record it
 * corrects by digest, restates the sha that record should have named, and takes
 * its place in the walk. Everything below is anchored to the real shas.
 */

const REPO = "1315419165";
const REF = "refs/heads/main";

const PRIOR = "a5f50bacb82ee5fc16de2efc73d320c7deff30fe";
const PRIOR_TREE = "87a2820524fe3020659eaee458e677d1391947cb";
const HEAD_107 = "8089c282d8d486af6e3b0465f7d2e0c6a4bde28b";
const TEST_MERGE = "ff6ea882feefd64c4e9f4dff909209e7adb281e3";
const REAL_MERGE = "0b2076107aa20f8b365d3b510de4838b05d12622";
const MERGE_TREE = "febb37430f3fd96c8b11e1b0f60ec0697b9f7cb6";
const PARENTS_DIGEST = "sha256:7e010ec98d073c4657e35f68b60431d1fcb764d0e4cdc5eccebd7a1e95ae9016";
const NEXT = "1f71202797b5000000000000000000000000abcd";
const ATTEMPT = "att_4a68f77c-4257-4896-9ba1-2174ee4e9a9e";

const D = (c: string) => `sha256:${c.repeat(64)}`;

/** The shape of the record that got it wrong, and of the one that got it right. */
function mergeRecord(over: {
  sequence: number;
  previous: string | null;
  before: { baseSha: string; treeOid: string };
  after: { baseSha: string; treeOid: string; parentOids: string[]; parentOidsDigest?: string };
  attemptId?: string;
  headSha?: string;
}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    kind: "reused-proof-merge",
    repositoryId: REPO,
    baseRef: REF,
    queueEpoch: 0,
    transitionSequence: over.sequence,
    previousTransitionDigest: over.previous,
    before: over.before,
    after: {
      baseSha: over.after.baseSha,
      treeOid: over.after.treeOid,
      parentOids: over.after.parentOids,
      parentCount: over.after.parentOids.length,
      parentOidsDigest: over.after.parentOidsDigest ?? PARENTS_DIGEST,
      parentsComplete: true,
    },
    observedAt: "2026-08-01T17:29:37.357Z",
    reusedProof: {
      attemptId: over.attemptId ?? ATTEMPT,
      mergeIntentDigest: D("1"),
      pullRequestNumber: 107,
      headSha: over.headSha ?? HEAD_107,
      candidateSha: over.after.baseSha,
      candidateTreeOid: over.after.treeOid,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      policyDigest: D("3"),
      pipelineDigest: D("4"),
      requiredSuitesDigest: D("5"),
      checkRunId: "91396799250",
    },
  };
}

function correctionRecord(over: {
  sequence: number;
  previous: string;
  corrects: { digest: string; sequence: number };
  before?: { baseSha: string; treeOid: string };
  after?: { baseSha: string; treeOid: string; parentOids: string[] };
  correctedBaseSha?: string;
  attemptId?: string;
}): Record<string, unknown> {
  const after = over.after ?? { baseSha: REAL_MERGE, treeOid: MERGE_TREE, parentOids: [PRIOR, HEAD_107] };
  return {
    schemaVersion: "1",
    kind: "base-correction",
    repositoryId: REPO,
    baseRef: REF,
    queueEpoch: 0,
    transitionSequence: over.sequence,
    previousTransitionDigest: over.previous,
    before: over.before ?? { baseSha: PRIOR, treeOid: PRIOR_TREE },
    after: {
      baseSha: after.baseSha,
      treeOid: after.treeOid,
      parentOids: after.parentOids,
      parentCount: after.parentOids.length,
      parentOidsDigest: PARENTS_DIGEST,
      parentsComplete: true,
    },
    observedAt: "2026-08-02T09:00:00.000Z",
    correction: {
      correctsTransitionDigest: over.corrects.digest,
      correctsTransitionSequence: over.corrects.sequence,
      correctedBaseSha: over.correctedBaseSha ?? TEST_MERGE,
      attemptId: over.attemptId ?? ATTEMPT,
      actorPrincipalId: "prn_amelia",
      reason: "the record names a temporary merge GitHub computed while the pull request was open",
    },
  };
}

async function asLink(record: Record<string, unknown>): Promise<ChainLink> {
  const bytes = canonicalBytes(JSON.stringify(record));
  return { digest: await envelopeDigest(bytes), bytes, jws: "signature", sequence: record["transitionSequence"] as number };
}

const ports = { verifySignature: async () => true, epochStartsAt: 53 };

/** Two signed records around the incorrect link, plus the record that follows. */
async function staging(): Promise<{ fiftyThree: ChainLink; fiftyFour: ChainLink; fiftyNine: ChainLink }> {
  const fiftyThree = await asLink(
    mergeRecord({
      sequence: 53,
      previous: D("a"),
      before: { baseSha: "a1fe3e7e32aed7eaeefe799174d5c4962331ac40", treeOid: "0".repeat(40) },
      after: { baseSha: PRIOR, treeOid: PRIOR_TREE, parentOids: ["a1fe3e7e32aed7eaeefe799174d5c4962331ac40", "1".repeat(40)] },
      attemptId: "att_earlier",
      headSha: "1".repeat(40),
    }),
  );
  const fiftyFour = await asLink(
    mergeRecord({
      sequence: 54,
      previous: fiftyThree.digest,
      before: { baseSha: PRIOR, treeOid: PRIOR_TREE },
      after: { baseSha: TEST_MERGE, treeOid: MERGE_TREE, parentOids: [PRIOR, HEAD_107] },
    }),
  );
  const fiftyNine = await asLink(
    mergeRecord({
      sequence: 55,
      previous: fiftyFour.digest,
      before: { baseSha: REAL_MERGE, treeOid: MERGE_TREE },
      after: { baseSha: NEXT, treeOid: "2".repeat(40), parentOids: [REAL_MERGE, "3".repeat(40)] },
      attemptId: "att_later",
      headSha: "3".repeat(40),
    }),
  );
  return { fiftyThree, fiftyFour, fiftyNine };
}

describe("the record as it stands", () => {
  it("stops the walk where nothing moves the base away from the test merge", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const { findings } = await verifyChain([fiftyThree, fiftyFour, fiftyNine], ports);
    expect(findings.map((f) => f.code)).toEqual(["BASE_DISCONTINUITY"]);
    expect(findings[0]!.detail).toContain(TEST_MERGE);
  });
});

describe("a base correction", () => {
  it("parses, and says which record it corrects and what that record should have said", async () => {
    const { fiftyFour } = await staging();
    const parsed = parseTransitionRecord(
      correctionRecord({ sequence: 61, previous: D("b"), corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("base-correction");
    if (parsed.value.kind !== "base-correction") return;
    expect(parsed.value.correction.correctsTransitionDigest).toBe(fiftyFour.digest);
    expect(parsed.value.correction.correctedBaseSha).toBe(TEST_MERGE);
    expect(parsed.value.after.baseSha).toBe(REAL_MERGE);
  });

  it("refuses to correct a record to the sha that record already names", async () => {
    const { fiftyFour } = await staging();
    const parsed = parseTransitionRecord(
      correctionRecord({
        sequence: 61,
        previous: D("b"),
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        after: { baseSha: TEST_MERGE, treeOid: MERGE_TREE, parentOids: [PRIOR, HEAD_107] },
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses to correct a record that comes after it", async () => {
    const { fiftyFour } = await staging();
    const parsed = parseTransitionRecord(
      correctionRecord({ sequence: 61, previous: D("b"), corrects: { digest: fiftyFour.digest, sequence: 62 } }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("verifying a chain that carries a correction", () => {
  it("follows the corrected edge and reports nothing", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({ sequence: 56, previous: fiftyNine.digest, corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings).toEqual([]);
    expect(result.signaturesChecked).toBe(4);
  });

  it("still serves the mistake, and says openly that one record was corrected", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({ sequence: 56, previous: fiftyNine.digest, corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({
      sequence: 56,
      digest: correction.digest,
      correctsSequence: 54,
      correctsDigest: fiftyFour.digest,
      from: TEST_MERGE,
      to: REAL_MERGE,
      observedAt: "2026-08-02T09:00:00.000Z",
      actorPrincipalId: "prn_amelia",
    });
  });

  it("does not report the corrected record and the correction as two ways off one base", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({ sequence: 56, previous: fiftyNine.digest, corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );
    const { findings } = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);
    expect(findings.map((f) => f.code)).not.toContain("FORKED_BASE");
  });

  /**
   * A correction may only change the sha. Moving where the record began would
   * let a correction relocate a merge in the branch's history, which is the
   * rewrite this whole design exists to refuse.
   */
  it("refuses a correction that moves where the record it cites began", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({
        sequence: 56,
        previous: fiftyNine.digest,
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        before: { baseSha: "9".repeat(40), treeOid: PRIOR_TREE },
      }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
    expect(result.corrections).toEqual([]);
  });

  /** The tree is what was verified. A correction that changes it certifies a tree nobody integrated. */
  it("refuses a correction that changes the tree the record certified", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({
        sequence: 56,
        previous: fiftyNine.digest,
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        after: { baseSha: REAL_MERGE, treeOid: "8".repeat(40), parentOids: [PRIOR, HEAD_107] },
      }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
    expect(result.corrections).toEqual([]);
  });

  it("refuses a correction that changes the parents the record recorded", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({
        sequence: 56,
        previous: fiftyNine.digest,
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        after: { baseSha: REAL_MERGE, treeOid: MERGE_TREE, parentOids: [PRIOR, "7".repeat(40)] },
      }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
  });

  it("refuses a correction whose cited record does not name the sha it says is wrong", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({
        sequence: 56,
        previous: fiftyNine.digest,
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        correctedBaseSha: "6".repeat(40),
      }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
  });

  it("refuses a correction that reassigns the merge to another attempt", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({
        sequence: 56,
        previous: fiftyNine.digest,
        corrects: { digest: fiftyFour.digest, sequence: 54 },
        attemptId: "att_somebody_else",
      }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
  });

  /**
   * A correction citing a record nobody served corrects nothing that can be
   * checked, and its edge would assert a base move on the strength of a record
   * the reader never saw.
   */
  it("refuses a correction whose record is not in the chain", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const correction = await asLink(
      correctionRecord({ sequence: 56, previous: fiftyNine.digest, corrects: { digest: D("f"), sequence: 54 } }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, correction], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_UNANCHORED");
    expect(result.corrections).toEqual([]);
  });

  /** Two corrections of one record are two answers to one question, so neither is followed. */
  it("refuses to follow either of two corrections of the same record", async () => {
    const { fiftyThree, fiftyFour, fiftyNine } = await staging();
    const first = await asLink(
      correctionRecord({ sequence: 56, previous: fiftyNine.digest, corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );
    const second = await asLink(
      correctionRecord({ sequence: 57, previous: first.digest, corrects: { digest: fiftyFour.digest, sequence: 54 } }),
    );

    const result = await verifyChain([fiftyThree, fiftyFour, fiftyNine, first, second], ports);

    expect(result.findings.map((f) => f.code)).toContain("CORRECTION_OVERREACHES");
    expect(result.corrections).toEqual([]);
  });
});
