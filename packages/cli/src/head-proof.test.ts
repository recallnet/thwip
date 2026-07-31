import { describe, expect, it } from "vitest";
import { attachTrailer, buildStatement } from "./proof.js";
import { headProofState } from "./head-proof.js";
import type { DsseEnvelope } from "@thwip/protocol";

/**
 * A rebase keeps the commit message, and the message is where the proof lives.
 * So a rebased commit carries a proof that names the tree it had before, and
 * nothing about the trailer's presence says whether it still describes this
 * commit. Deciding that from presence alone let `ship` skip signing, and the
 * required check then failed with SUBJECT_TREE_MISMATCH — three times in one
 * night, each costing a full round trip through CI to discover.
 */

const TREE = "a".repeat(40);
const OTHER = "b".repeat(40);

function messageWithProofFor(treeOid: string): string {
  const statement = buildStatement({
    subject: {
      headSha: "9".repeat(40),
      treeOid,
      parentOids: ["c".repeat(40)],
      baseRef: "refs/heads/main",
      baseSha: "d".repeat(40),
      objectFormat: "sha1",
    },
    ownerId: "1",
    repositoryId: "2",
    policyDigest: `sha256:${"e".repeat(64)}`,
    policyVersion: 4,
    pipelineDigest: `sha256:${"f".repeat(64)}`,
    runner: "command",
    suites: [{ id: "test", status: "passed", durationMs: 10 }],
    startedAt: "2026-07-31T06:00:00.000Z",
    finishedAt: "2026-07-31T06:00:10.000Z",
    keyId: "SHA256:k",
    githubUserId: "3",
    privateKeyPath: "/dev/null",
  });
  const envelope: DsseEnvelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: btoa(JSON.stringify(statement)),
    signatures: [{ keyid: "SHA256:k", sig: "AAAA" }],
  };
  return attachTrailer("some commit subject\n\nbody\n", envelope);
}

describe("what HEAD's proof says about HEAD's tree", () => {
  it("accepts a proof that names this exact tree", () => {
    expect(headProofState(messageWithProofFor(TREE), TREE)).toBe("accepted");
  });

  it("calls a proof stale when the tree has moved under it, as a rebase does", () => {
    expect(headProofState(messageWithProofFor(OTHER), TREE)).toBe("stale");
  });

  it("reports a commit with no proof at all as missing", () => {
    expect(headProofState("just a commit message\n", TREE)).toBe("missing");
  });

  it("reports an unreadable proof as missing rather than trusting it", () => {
    const message = "subject\n\nthwip-proof: v1.not-base64-at-all\n";
    expect(headProofState(message, TREE)).toBe("missing");
  });

  it("reports a proof whose payload is not a statement as missing", () => {
    const envelope: DsseEnvelope = {
      payloadType: "application/vnd.in-toto+json",
      payload: btoa(JSON.stringify({ nonsense: true })),
      signatures: [{ keyid: "SHA256:k", sig: "AAAA" }],
    };
    expect(headProofState(attachTrailer("subject\n", envelope), TREE)).toBe("missing");
  });

  /**
   * Stale and missing both mean "sign again", so the distinction only earns its
   * place if it reaches the person: one is a rebase, the other is a commit that
   * was never signed, and they are fixed by the same command for different
   * reasons.
   */
  it("distinguishes the two rather than collapsing them", () => {
    expect(headProofState(messageWithProofFor(OTHER), TREE)).not.toBe(
      headProofState("no proof here\n", TREE),
    );
  });
});
