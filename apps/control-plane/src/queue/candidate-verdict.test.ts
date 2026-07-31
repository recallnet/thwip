import { describe, expect, it } from "vitest";
import {
  candidateResultBytes,
  candidateResultDigest,
  decideCandidate,
  requiresIntegratedRun,
} from "./candidate-verdict.js";
import type { CandidateVerdict } from "./store.js";

const TREE = "4".repeat(40);
const CANDIDATE = "3".repeat(40);
const BASE = "1".repeat(40);
const REF = "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main";
const WF_SHA = "5".repeat(40);
const POLICY = `sha256:${"a".repeat(64)}`;

const REQUIRED = ["lint", "typecheck", "test"];

async function verdict(over: Partial<CandidateVerdict> = {}): Promise<CandidateVerdict> {
  const base = {
    candidateTreeOid: TREE,
    candidateSha: CANDIDATE,
    baseSha: BASE,
    pullRequestNumber: 42,
    accepted: true,
    policyDigest: POLICY,
    suites: [
      { name: "lint", outcome: "passed" as const, durationMs: 205 },
      { name: "typecheck", outcome: "passed" as const, durationMs: 1916 },
      { name: "test", outcome: "passed" as const, durationMs: 693 },
    ],
    reasonCodes: [] as string[],
    workflowRef: REF,
    workflowSha: WF_SHA,
    runId: "556677",
    observedAt: "2026-07-30T06:00:00Z",
    ...over,
  };
  return { ...base, resultDigest: over.resultDigest ?? (await candidateResultDigest(base)) };
}

const expected = {
  candidateTreeOid: TREE,
  candidateSha: CANDIDATE,
  baseSha: BASE,
  requiredSuites: REQUIRED,
  policyDigest: POLICY,
  workflowRef: REF,
  workflowSha: WF_SHA,
};

describe("decideCandidate", () => {
  it("accepts a verdict that ran every required suite against this exact tree", async () => {
    expect(await decideCandidate(await verdict(), expected)).toMatchObject({ ok: true });
  });

  it("refuses when nothing has verified the candidate", async () => {
    expect(await decideCandidate(null, expected)).toMatchObject({ code: "CANDIDATE_NOT_VERIFIED" });
  });

  describe("the verdict must be about this integration", () => {
    it("refuses a verdict for another tree", async () => {
      const other = await verdict({ candidateTreeOid: "9".repeat(40) });
      expect(await decideCandidate(other, expected)).toMatchObject({ code: "CANDIDATE_TREE_MISMATCH" });
    });

    /**
     * The commit hash folds in the message, author and timestamp as well as the
     * code, so GitHub recreating a merge commit for an unchanged pull request
     * changes it. Gating on it deadlocked a pull request: a verdict is immutable
     * and keyed by tree, so no hash could ever match again.
     */
    it("accepts a verdict whose candidate commit was recreated over the same tree and base", async () => {
      const other = await verdict({ candidateSha: "9".repeat(40) });
      expect(await decideCandidate(other, expected)).toMatchObject({ ok: true });
    });

    it("refuses when the base moved after the candidate was verified", async () => {
      const other = await verdict({ baseSha: "9".repeat(40) });
      expect(await decideCandidate(other, expected)).toMatchObject({ code: "CANDIDATE_BASE_MOVED" });
    });
  });

  describe("the verdict must come from the pinned verifier", () => {
    it("refuses another workflow", async () => {
      const other = await verdict({ workflowRef: "recallnet/thwip/.github/workflows/evil.yml@refs/heads/main" });
      expect(await decideCandidate(other, expected)).toMatchObject({
        code: "CANDIDATE_VERIFIER_NOT_PINNED",
      });
    });

    it("refuses the pinned workflow at another revision", async () => {
      const other = await verdict({ workflowSha: "9".repeat(40) });
      expect(await decideCandidate(other, expected)).toMatchObject({
        code: "CANDIDATE_VERIFIER_NOT_PINNED",
      });
    });
  });

  it("refuses when the policy changed after verification", async () => {
    const other = await verdict({ policyDigest: `sha256:${"b".repeat(64)}` });
    expect(await decideCandidate(other, expected)).toMatchObject({ code: "CANDIDATE_POLICY_MISMATCH" });
  });

  it("refuses a rejected verdict and says why", async () => {
    const refused = await verdict({ accepted: false, reasonCodes: ["SUITE_NOT_PASSED"] });
    expect(await decideCandidate(refused, expected)).toMatchObject({
      code: "CANDIDATE_REJECTED",
      detail: "SUITE_NOT_PASSED",
    });
  });

  describe("an acceptance is checked against what actually ran", () => {
    it("refuses an acceptance that skipped a required suite", async () => {
      const partial = await verdict({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 205 },
          { name: "typecheck", outcome: "passed", durationMs: 1916 },
        ],
      });
      const decision = await decideCandidate(partial, expected);
      expect(decision).toMatchObject({ code: "CANDIDATE_SUITES_INCOMPLETE" });
      if (!decision.ok) expect(decision.detail).toMatch(/test/);
    });

    it("refuses an acceptance whose required suite did not pass", async () => {
      const failing = await verdict({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 205 },
          { name: "typecheck", outcome: "passed", durationMs: 1916 },
          { name: "test", outcome: "failed", durationMs: 693 },
        ],
      });
      expect(await decideCandidate(failing, expected)).toMatchObject({
        code: "CANDIDATE_SUITE_NOT_PASSED",
      });
    });

    it("refuses an acceptance whose required suite was skipped rather than run", async () => {
      const skipped = await verdict({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 205 },
          { name: "typecheck", outcome: "passed", durationMs: 1916 },
          { name: "test", outcome: "skipped", durationMs: 0 },
        ],
      });
      expect(await decideCandidate(skipped, expected)).toMatchObject({
        code: "CANDIDATE_SUITE_NOT_PASSED",
      });
    });
  });

  describe("the digest binds the verdict to its own content", () => {
    it("refuses a verdict whose outcome was edited after it was signed for", async () => {
      const original = await verdict({ accepted: false, reasonCodes: ["SUITE_NOT_PASSED"] });
      // Flip the answer while keeping the digest that was computed for a refusal.
      const tampered = { ...original, accepted: true, reasonCodes: [] };
      expect(await decideCandidate(tampered, expected)).toMatchObject({
        code: "CANDIDATE_DIGEST_MISMATCH",
      });
    });

    it("refuses a verdict whose failing suite was rewritten to passing", async () => {
      const original = await verdict({
        suites: [
          { name: "lint", outcome: "passed", durationMs: 205 },
          { name: "typecheck", outcome: "passed", durationMs: 1916 },
          { name: "test", outcome: "failed", durationMs: 693 },
        ],
      });
      const tampered = {
        ...original,
        suites: original.suites.map((s) => ({ ...s, outcome: "passed" as const })),
      };
      expect(await decideCandidate(tampered, expected)).toMatchObject({
        code: "CANDIDATE_DIGEST_MISMATCH",
      });
    });

    it("does not depend on the order suites are reported in", async () => {
      const a = await verdict();
      const reordered = await candidateResultDigest({ ...a, suites: [...a.suites].reverse() });
      expect(reordered).toBe(a.resultDigest);
    });

    it("changes when the tree changes", async () => {
      const a = await verdict();
      const b = await candidateResultDigest({ ...a, candidateTreeOid: "9".repeat(40) });
      expect(b).not.toBe(a.resultDigest);
    });
  });
});

/**
 * `fast` states that the evidence is the proof already on the pull request head.
 * Merging on it is what that policy asks for. Every other profile claims the
 * integration itself was run, and that claim is only true if something ran it.
 */
describe("requiresIntegratedRun", () => {
  it("does not demand one under the fast profile", () => {
    expect(requiresIntegratedRun("fast")).toBe(false);
  });

  it("demands one under every stronger profile", () => {
    for (const profile of ["fresh", "remote", "audited"]) {
      expect(requiresIntegratedRun(profile), profile).toBe(true);
    }
  });

  it("demands one for a profile it does not recognise", () => {
    // An unknown profile is not a licence to claim less was needed.
    expect(requiresIntegratedRun("something-new")).toBe(true);
  });
});

describe("an unpinned verifier revision", () => {
  const anyRevision = { ...expected, workflowSha: null };

  it("accepts the pinned workflow at any revision of the default branch", async () => {
    const later = await verdict({ workflowSha: "9".repeat(40) });
    expect(await decideCandidate(later, anyRevision)).toMatchObject({ ok: true });
  });

  it("still refuses another workflow path", async () => {
    const other = await verdict({ workflowRef: "recallnet/thwip/.github/workflows/evil.yml@refs/heads/main" });
    expect(await decideCandidate(other, anyRevision)).toMatchObject({
      code: "CANDIDATE_VERIFIER_NOT_PINNED",
    });
  });

  it("still binds the revision into the digest, so it cannot be rewritten", async () => {
    const original = await verdict();
    const tampered = { ...original, workflowSha: "9".repeat(40) };
    expect(await decideCandidate(tampered, anyRevision)).toMatchObject({
      code: "CANDIDATE_DIGEST_MISMATCH",
    });
  });
});

/**
 * Evidence is named by the hash of its own content, so a reader can check what
 * they fetched without trusting the store. That only holds if the bytes written
 * are the bytes the digest was taken over.
 */
describe("candidateResultBytes", () => {
  async function sha256(bytes: Uint8Array): Promise<string> {
    const h = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return `sha256:${[...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  it("hashes to the digest the chain records", async () => {
    const v = await verdict();
    expect(await sha256(candidateResultBytes(v))).toBe(v.resultDigest);
  });

  it("hashes to the digest for a refusal too", async () => {
    const v = await verdict({ accepted: false, reasonCodes: ["SUITE_NOT_PASSED"] });
    expect(await sha256(candidateResultBytes(v))).toBe(v.resultDigest);
  });

  it("round-trips as JSON a reader can parse", async () => {
    const v = await verdict();
    const parsed = JSON.parse(new TextDecoder().decode(candidateResultBytes(v)));
    expect(parsed).toMatchObject({
      predicate: "urn:thwip:queue:candidate-verdict:v1",
      candidateTreeOid: TREE,
      accepted: true,
    });
    expect(parsed.suites.map((s: { name: string }) => s.name)).toEqual(["lint", "test", "typecheck"]);
  });

  it("gives different bytes for a different tree", async () => {
    const v = await verdict();
    expect(candidateResultBytes({ ...v, candidateTreeOid: "9".repeat(40) })).not.toEqual(
      candidateResultBytes(v),
    );
  });
});
