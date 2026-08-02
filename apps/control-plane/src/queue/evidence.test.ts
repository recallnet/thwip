import { describe, expect, it } from "vitest";
import {
  buildAssignment,
  buildMergeIntent,
  buildTransitionRecord,
  liveGuardDigest,
  reuseEquivalenceDigests,
  signAssignment,
  signMergeIntent,
  signTransitionRecord,
  type Signer,
} from "./evidence.js";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;

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

/** Records the exact bytes it was asked to sign, so tests can compare them. */
function recordingSigner(): Signer & { signed: Uint8Array[] } {
  const signed: Uint8Array[] = [];
  return {
    signed,
    async sign(bytes) {
      signed.push(bytes);
      return `jws.${bytes.byteLength}`;
    },
  };
}

async function assignmentDoc(over: Record<string, unknown> = {}) {
  return {
    ...(await buildAssignment({
      assignmentId: "asg-1",
      attemptId: "att-1",
      ownerId: "162603603",
      git,
      queue: {
        queueEpoch: 0,
        turnSequence: 3,
        entryId: "entry-1",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        queueDecisionDigest: D("b"),
      },
      policy: {
        version: 4,
        securityProfile: "fresh",
        runner: "dagger",
        daggerModuleDigest: D("c"),
        daggerEngineDigest: D("d"),
        requiredSuites: ["lint", "test"],
        document: { profile: "fresh", required: ["lint", "test"] },
      },
      execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: "key-1" },
      evidence: { workReceiptDigest: D("e"), previousTransitionDigest: null },
      issuedAt: "2026-07-29T12:00:00Z",
      executionSeconds: 20 * 60,
      nonce: "nonce-1",
    })),
    ...over,
  };
}

describe("buildAssignment", () => {
  it("computes the policy digest rather than accepting one", async () => {
    const a = await assignmentDoc();
    const b = await buildAssignment({
      assignmentId: "asg-1",
      attemptId: "att-1",
      ownerId: "162603603",
      git,
      queue: {
        queueEpoch: 0,
        turnSequence: 3,
        entryId: "entry-1",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        queueDecisionDigest: D("b"),
      },
      policy: {
        version: 4,
        securityProfile: "fresh",
        runner: "dagger",
        daggerModuleDigest: D("c"),
        daggerEngineDigest: D("d"),
        requiredSuites: ["lint", "test"],
        // A different policy document must produce a different digest.
        document: { profile: "fresh", required: ["lint", "test", "build"] },
      },
      execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: "key-1" },
      evidence: { workReceiptDigest: D("e"), previousTransitionDigest: null },
      issuedAt: "2026-07-29T12:00:00Z",
      executionSeconds: 20 * 60,
      nonce: "nonce-1",
    });
    const aDigest = (a["policy"] as { digest: string }).digest;
    const bDigest = (b["policy"] as { digest: string }).digest;
    expect(aDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(aDigest).not.toBe(bDigest);
  });

  it("derives the expiry from the execution window", async () => {
    const doc = await assignmentDoc();
    expect(doc["timing"]).toEqual({
      issuedAt: "2026-07-29T12:00:00Z",
      notBefore: "2026-07-29T12:00:00Z",
      expiresAt: "2026-07-29T12:20:00.000Z",
    });
  });

  it("produces a document the protocol accepts", async () => {
    const signed = await signAssignment(await assignmentDoc(), recordingSigner());
    expect("error" in signed ? signed.error : "ok").toBe("ok");
  });
});

describe("signRecord", () => {
  it("refuses to sign a record the protocol rejects", async () => {
    const signer = recordingSigner();
    const bad = await signAssignment(await assignmentDoc({ nonce: "" }), signer);
    expect("error" in bad).toBe(true);
    // Nothing was signed, so no signature exists over an invalid payload.
    expect(signer.signed).toHaveLength(0);
  });

  it("digests the exact bytes it signed", async () => {
    const signer = recordingSigner();
    const result = await signAssignment(await assignmentDoc(), signer);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(signer.signed).toHaveLength(1);
    expect(result.bytes).toEqual(signer.signed[0]);
    // The digest must be reproducible from the returned bytes.
    const rehash = await crypto.subtle.digest("SHA-256", result.bytes as unknown as ArrayBuffer);
    const hex = [...new Uint8Array(rehash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(result.digest).toBe(`sha256:${hex}`);
  });

  it("is stable across key order in the input", async () => {
    const doc = await assignmentDoc();
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    const a = await signAssignment(doc, recordingSigner());
    const b = await signAssignment(reordered, recordingSigner());
    if ("error" in a || "error" in b) throw new Error("expected both to validate");
    expect(b.digest).toBe(a.digest);
  });
});

describe("buildMergeIntent", () => {
  const common = {
    operationId: "op-1",
    attemptId: "att-1",
    git,
    queueEpoch: 0,
    turnSequence: 3,
    transitionSequence: 9,
    pullRequestNumber: 42,
    mergeMethod: "merge" as const,
    policyDigest: D("c"),
    previousTransitionDigest: D("f"),
    commitTitle: "Merge pull request #42",
    commitMessage: "a body long enough to matter\n\nthwip-queue-transition: ...",
    createdAt: "2026-07-29T12:00:00Z",
  };

  it("digests the commit message instead of embedding it", async () => {
    const doc = await buildMergeIntent({
      ...common,
      evidence: {
        kind: "verified",
        workReceiptDigest: D("1"),
        assignmentDigest: D("2"),
        integrationEvidenceDigest: D("3"),
        pipelineDigest: D("6"),
        requiredSuitesDigest: D("7"),
        execution: { ranOn: "device", deviceKeyId: "dev-1" },
      },
    });
    expect(doc["generatedCommitMessageDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(doc)).not.toContain("thwip-queue-transition");
  });

  it("produces a verified intent the protocol accepts, with no override field", async () => {
    const doc = await buildMergeIntent({
      ...common,
      evidence: {
        kind: "verified",
        workReceiptDigest: D("1"),
        assignmentDigest: D("2"),
        integrationEvidenceDigest: D("3"),
        pipelineDigest: D("6"),
        requiredSuitesDigest: D("7"),
        execution: { ranOn: "device", deviceKeyId: "dev-1" },
      },
    });
    expect(doc["override"]).toBeUndefined();
    const signed = await signMergeIntent(doc, recordingSigner());
    expect("error" in signed ? signed.error : "ok").toBe("ok");
  });

  it("produces an override intent carrying its authorization and no verifier digest", async () => {
    const doc = await buildMergeIntent({
      ...common,
      evidence: {
        kind: "override",
        workReceiptDigest: D("1"),
        assignmentDigest: D("2"),
        liveGuardDigest: D("5"),
        candidateCheckRunId: "5566",
        override: {
          actorGithubId: "264261678",
          reason: "verifier outage during a release freeze",
          omission: { profile: "fresh", omittedControls: ["integration_receipt", "integration_verifier_result"] },
        } as never,
      },
    });
    expect(JSON.stringify(doc["evidence"])).not.toContain("verifierResultDigest");
    const signed = await signMergeIntent(doc, recordingSigner());
    expect("error" in signed ? signed.error : "ok").toBe("ok");
  });
});

describe("buildTransitionRecord", () => {
  it("binds the full parent vector by digest and count", async () => {
    const doc = await buildTransitionRecord({
      git,
      queueEpoch: 0,
      transitionSequence: 2,
      previousTransitionDigest: D("f"),
      before: { baseSha: BASE, treeOid: "9".repeat(40) },
      final: { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD] },
      observedAt: "2026-07-29T12:05:00Z",
      mergeMethod: "merge",
      attemptId: "att-1",
      pullRequestNumber: 42,
      mergeIntentDigest: D("1"),
      workReceiptDigest: D("2"),
      assignmentDigest: D("3"),
      integrationEvidenceDigest: D("4"),
      policyDigest: D("6"),
      pipelineDigest: D("7"),
      requiredSuitesDigest: D("8"),
      execution: { ranOn: "github-actions", verifierResultDigest: D("5"), checkRunId: "7788", actionRunId: "9900" },
    });
    const after = doc["after"] as Record<string, unknown>;
    expect(after["parentCount"]).toBe(2);
    expect(after["parentsComplete"]).toBe(true);
    expect(after["parentOidsDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    const signed = await signTransitionRecord(doc, recordingSigner());
    expect("error" in signed ? signed.error : "ok").toBe("ok");
  });

  it("marks an over-long parent vector incomplete while still binding it", async () => {
    const parents = Array.from({ length: 20 }, (_, i) => String(i % 10).repeat(40));
    const doc = await buildTransitionRecord({
      git,
      queueEpoch: 0,
      transitionSequence: 2,
      previousTransitionDigest: D("f"),
      before: { baseSha: BASE, treeOid: "9".repeat(40) },
      final: { sha: CANDIDATE, treeOid: TREE, parentShas: parents },
      observedAt: "2026-07-29T12:05:00Z",
      mergeMethod: "merge",
      attemptId: "att-1",
      pullRequestNumber: 42,
      mergeIntentDigest: D("1"),
      workReceiptDigest: D("2"),
      assignmentDigest: D("3"),
      integrationEvidenceDigest: D("4"),
      policyDigest: D("6"),
      pipelineDigest: D("7"),
      requiredSuitesDigest: D("8"),
      execution: { ranOn: "github-actions", verifierResultDigest: D("5"), checkRunId: "7788", actionRunId: "9900" },
    });
    const after = doc["after"] as Record<string, unknown>;
    expect((after["parentOids"] as unknown[]).length).toBe(16);
    expect(after["parentCount"]).toBe(20);
    expect(after["parentsComplete"]).toBe(false);
  });
});

describe("reuseEquivalenceDigests", () => {
  it("normalizes suite order, because the same suites are the same work", async () => {
    const a = await reuseEquivalenceDigests({
      requiredSuites: ["lint", "test"],
      pipelineDocument: { runner: "dagger" },
      policyDocument: { profile: "fast" },
    });
    const b = await reuseEquivalenceDigests({
      requiredSuites: ["test", "lint"],
      pipelineDocument: { runner: "dagger" },
      policyDocument: { profile: "fast" },
    });
    expect(b.requiredSuitesDigest).toBe(a.requiredSuitesDigest);
  });

  it("changes when the suite set changes", async () => {
    const a = await reuseEquivalenceDigests({
      requiredSuites: ["lint"],
      pipelineDocument: {},
      policyDocument: {},
    });
    const b = await reuseEquivalenceDigests({
      requiredSuites: ["lint", "test"],
      pipelineDocument: {},
      policyDocument: {},
    });
    expect(b.requiredSuitesDigest).not.toBe(a.requiredSuitesDigest);
  });
});

describe("liveGuardDigest", () => {
  it("is stable regardless of fact ordering", async () => {
    const a = await liveGuardDigest({ baseSha: BASE, headSha: HEAD, reviews: true });
    const b = await liveGuardDigest({ reviews: true, headSha: HEAD, baseSha: BASE });
    expect(b).toBe(a);
  });

  it("changes when any fact changes", async () => {
    const a = await liveGuardDigest({ baseSha: BASE, reviews: true });
    const b = await liveGuardDigest({ baseSha: BASE, reviews: false });
    expect(b).not.toBe(a);
  });
});
