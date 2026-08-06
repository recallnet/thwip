import { describe, expect, it } from "vitest";
import { candidateResultDigest, decideCandidate } from "./candidate-verdict.js";
import type { CandidateVerdict } from "./store.js";

/**
 * Adversarial probes of the candidate verdict. Each failed when it was written;
 * each now pins the behaviour that fixed it.
 */

const TREE = "4".repeat(40);
const CANDIDATE = "3".repeat(40);
const BASE = "1".repeat(40);
const REF = "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main";
const WF_SHA = "5".repeat(40);
const POLICY = `sha256:${"a".repeat(64)}`;
const REQUIRED = ["lint", "typecheck", "test"];

async function verdict(over: Partial<CandidateVerdict> = {}): Promise<CandidateVerdict> {
  const body = {
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
  return { ...body, resultDigest: over.resultDigest ?? (await candidateResultDigest(body)) };
}

const expectation = {
  candidateTreeOid: TREE,
  candidateSha: CANDIDATE,
  baseSha: BASE,
  requiredSuites: REQUIRED,
  policyDigest: POLICY,
  workflowRef: REF,
  workflowSha: WF_SHA,
};

describe("ADVERSARIAL: the merge gate reading a verifier's verdict", () => {
  it("does not let a suite reported twice hide the run that failed", async () => {
    // The verifier workflow re-runs one job and reports both results. The gate
    // indexes suites by name into a Map, so the last entry wins and a failure is
    // erased. The digest still matches, because it is computed over the same list.
    const stored = await verdict({
      suites: [
        { name: "lint", outcome: "passed", durationMs: 205 },
        { name: "typecheck", outcome: "passed", durationMs: 1916 },
        { name: "test", outcome: "failed", durationMs: 693 },
        { name: "test", outcome: "passed", durationMs: 4 },
      ],
    });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok, "a failed run was masked by a later duplicate").toBe(false);
  });
});

describe("ADVERSARIAL: merge-gate defences that already hold", () => {
  it("refuses a verdict about another tree", async () => {
    const stored = await verdict({ candidateTreeOid: "9".repeat(40) });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_TREE_MISMATCH");
  });

  it("refuses a verdict earned against a base that has since moved", async () => {
    const stored = await verdict({ baseSha: "9".repeat(40) });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_BASE_MOVED");
  });

  it("refuses a verdict edited after it was stored", async () => {
    const honest = await verdict({ accepted: false, reasonCodes: ["SUITE_FAILED"] });
    const tampered: CandidateVerdict = { ...honest, accepted: true, reasonCodes: [] };
    const decision = await decideCandidate(tampered, expectation);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_DIGEST_MISMATCH");
  });

  it("refuses a verdict from a workflow the repository never pinned", async () => {
    const stored = await verdict({ workflowRef: "attacker/repo/.github/workflows/x.yml@refs/heads/main" });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_VERIFIER_NOT_PINNED");
  });

  it("refuses an accepted verdict that skipped a required suite", async () => {
    const stored = await verdict({
      suites: [
        { name: "lint", outcome: "passed", durationMs: 1 },
        { name: "typecheck", outcome: "passed", durationMs: 1 },
      ],
    });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_SUITES_INCOMPLETE");
  });

  it("refuses a verdict verified under a policy that has since changed", async () => {
    const stored = await verdict({ policyDigest: `sha256:${"b".repeat(64)}` });
    const decision = await decideCandidate(stored, expectation);
    expect(decision.ok === false && decision.code).toBe("CANDIDATE_POLICY_MISMATCH");
  });
});
