import { describe, expect, it } from "vitest";
import { canonicalBytes, envelopeDigest } from "./canonical.js";
import { verifyChain, type ChainLink } from "./verify-chain.js";

/**
 * Walking a branch's chain and saying whether it holds.
 *
 * Until this existed the chain was a claim. Records were signed and stored and
 * nothing ever checked that the links joined up, that a digest named its own
 * bytes, or that the signature was real. The first two merges to land without a
 * record went unnoticed for exactly that reason.
 *
 * Pure on purpose. Signature checking is injected so this runs unchanged in the
 * Worker, in the CLI, and here.
 */

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "4".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}`;

async function link(sequence: number, previous: string | null, over: Record<string, unknown> = {}): Promise<ChainLink> {
  const record = {
    schemaVersion: "1",
    kind: "reused-proof-merge",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 1,
    transitionSequence: sequence,
    previousTransitionDigest: previous,
    before: { baseSha: BASE, treeOid: "5".repeat(40) },
    after: {
      baseSha: "3".repeat(40),
      treeOid: TREE,
      parentOids: [BASE, HEAD],
      parentCount: 2,
      parentOidsDigest: D("7"),
      parentsComplete: true,
    },
    observedAt: "2026-07-31T12:00:00Z",
    reusedProof: {
      attemptId: `att-${sequence}`,
      mergeIntentDigest: D("1"),
      pullRequestNumber: sequence,
      headSha: HEAD,
      candidateSha: "3".repeat(40),
      candidateTreeOid: TREE,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      policyDigest: D("6"),
      pipelineDigest: D("8"),
      requiredSuitesDigest: D("9"),
      checkRunId: "778899",
    },
    ...over,
  };
  const bytes = canonicalBytes(JSON.stringify(record));
  return { digest: await envelopeDigest(bytes), bytes, jws: "signature" };
}

const signedOk = { verifySignature: async () => true, epochStartsAt: 1 };

describe("verifying a chain", () => {
  it("accepts a chain whose links join up", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    expect(await verifyChain([one, two], signedOk)).toEqual([]);
  });

  it("reports a digest that does not name its own bytes", async () => {
    const one = await link(1, null);
    const tampered = { ...one, digest: D("0") };
    const findings = await verifyChain([tampered], signedOk);
    expect(findings.map((f) => f.code)).toContain("DIGEST_MISMATCH");
  });

  it("reports a link that names the wrong predecessor", async () => {
    const one = await link(1, null);
    const two = await link(2, D("0"));
    const findings = await verifyChain([one, two], signedOk);
    expect(findings.map((f) => f.code)).toContain("BROKEN_LINK");
  });

  /** The failure that actually happened: two merges landed and wrote no record. */
  it("reports a gap where a sequence number is missing", async () => {
    const one = await link(1, null);
    const three = await link(3, one.digest);
    const findings = await verifyChain([one, three], signedOk);
    expect(findings.map((f) => f.code)).toContain("SEQUENCE_GAP");
  });

  it("reports a signature that does not verify", async () => {
    const one = await link(1, null);
    const findings = await verifyChain([one], { verifySignature: async () => false, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
  });

  it("reports bytes that are not a record at all", async () => {
    const junk: ChainLink = {
      digest: await envelopeDigest(canonicalBytes("{}")),
      bytes: canonicalBytes("{}"),
      jws: "signature",
    };
    const findings = await verifyChain([junk], signedOk);
    expect(findings.map((f) => f.code)).toContain("UNPARSEABLE");
  });

  /**
   * Links written before records existed are padded commit ids. They are history,
   * not forgery, and a verifier that cannot tell the two apart is useless on any
   * repository that predates the change.
   */
  it("calls pre-epoch links out separately instead of failing them", async () => {
    const old: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "" };
    const findings = await verifyChain([old], { verifySignature: async () => false, epochStartsAt: 2 });
    expect(findings.map((f) => f.code)).toEqual(["PRE_ATTESTATION"]);
  });
});
