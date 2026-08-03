import { describe, expect, it } from "vitest";
import { proofShortfall, workReceiptDigestFrom } from "./work-receipt.js";

/**
 * The digest of the proof the developer actually signed.
 *
 * The merge walk bound `sha256:2222…2222` here — a constant, not a digest of
 * anything. Everything downstream that cites a work receipt was citing that, so
 * the chain's claim to say what was checked before a merge landed was empty.
 *
 * The proof is already on the head commit and the required check already
 * verifies it, so the evidence exists and was simply never carried through.
 *
 * The digest is taken over the exact carrier bytes as they appear in the commit,
 * never over a re-serialisation: a digest only names the thing it was computed
 * over, and re-encoding produces a different thing that happens to mean the same.
 */

// A real carrier from this repository's history, trimmed to the trailer line.
const CARRIER =
  "v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlmUT09Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6ayIsInNpZyI6IkFBQUEifV19";

const withProof = (message: string) => `${message}\n\nthwip-proof: ${CARRIER}\n`;

describe("the work receipt digest", () => {
  it("is a sha256 over the carrier the commit carries", async () => {
    const digest = await workReceiptDigestFrom(withProof("feat: something"));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is the same for the same proof, whatever else the message says", async () => {
    const [a, b] = await Promise.all([
      workReceiptDigestFrom(withProof("feat: one subject")),
      workReceiptDigestFrom(withProof("fix: an entirely different subject\n\nwith a body")),
    ]);
    expect(a).toBe(b);
  });

  it("differs for a different proof", async () => {
    const other = `${CARRIER.slice(0, -4)}AAAA`;
    const [a, b] = await Promise.all([
      workReceiptDigestFrom(withProof("x")),
      workReceiptDigestFrom(`x\n\nthwip-proof: ${other}\n`),
    ]);
    expect(a).not.toBe(b);
  });

  /**
   * Absent is not zero. A commit with no proof has no work receipt, and
   * returning a digest anyway is how a placeholder gets into a signed record.
   */
  it("is nothing when the commit carries no proof", async () => {
    expect(await workReceiptDigestFrom("just a commit message\n")).toBeNull();
  });

  it("is nothing when the carrier cannot be read", async () => {
    expect(await workReceiptDigestFrom("x\n\nthwip-proof: v1.not-base64\n")).toBeNull();
  });

  it("is nothing when the commit carries two, rather than guessing which", async () => {
    const twice = `x\n\nthwip-proof: ${CARRIER}\nthwip-proof: ${CARRIER}\n`;
    expect(await workReceiptDigestFrom(twice)).toBeNull();
  });
});

/**
 * What a proof can fail, and what it cannot.
 *
 * Requirements, never identity. A policy's digest moves when a setting no proof
 * can fail moves: the minimum permission, the allowed key algorithms, the lease
 * rules, the proof's maximum age. Refusing on the digest invalidated every proof
 * in flight over a cosmetic edit, and the App carried a twenty-four hour list of
 * retired digests to hide it. The list is gone.
 *
 * The same two comparisons the merge gate makes, in the same order, so readiness
 * and the merge gate cannot reach different verdicts about one head.
 */
describe("proofShortfall", () => {
  const PIPELINE = `sha256:${"c".repeat(64)}`;
  const proof = (over: Partial<Parameters<typeof proofShortfall>[0] & object> = {}) => ({
    policyDigest: `sha256:${"b".repeat(64)}`,
    pipelineDigest: PIPELINE,
    passedSuites: ["unit"],
    ...over,
  });

  it("finds nothing wrong with a proof that ran the pipeline and passed the suites", () => {
    expect(proofShortfall(proof(), { pipelineDigest: PIPELINE, requiredSuites: ["unit"] })).toBeNull();
  });

  it("ignores the policy's own digest, so a cosmetic edit costs nothing", () => {
    // The proof cites one policy and another is in force. Nothing it has to
    // satisfy has changed, so it still merges.
    expect(
      proofShortfall(proof({ policyDigest: `sha256:${"9".repeat(64)}` }), {
        pipelineDigest: PIPELINE,
        requiredSuites: ["unit"],
      }),
    ).toBeNull();
  });

  it("names the pipeline the proof ran when the policy names another", () => {
    const shortfall = proofShortfall(proof(), {
      pipelineDigest: `sha256:${"e".repeat(64)}`,
      requiredSuites: ["unit"],
    });
    expect(shortfall).toContain(PIPELINE);
  });

  it("names the suite the policy added after the proof was signed", () => {
    expect(
      proofShortfall(proof(), { pipelineDigest: PIPELINE, requiredSuites: ["unit", "integration"] }),
    ).toContain("integration");
  });

  it("has nothing to say about a head whose proof cannot be read", () => {
    expect(proofShortfall(null, { pipelineDigest: PIPELINE, requiredSuites: ["unit"] })).toBeNull();
  });

  it("has nothing to say when the policy names no pipeline", () => {
    expect(proofShortfall(proof(), { pipelineDigest: null, requiredSuites: ["unit"] })).toBeNull();
  });
});
