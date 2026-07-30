import { recordDigest } from "@thwip/queue-protocol";
import type { CandidateSuite, CandidateVerdict } from "./store.js";

/**
 * Whether a verifier's verdict may back a merge (plan.md §16, §18.3).
 *
 * Until this existed the merge-preparation path walked an attempt to merge-ready
 * with a constant standing in for the verifier's result. The queue then recorded
 * a verified transition, and what it had actually verified was the proof on the
 * pull request head — work done before the branch was integrated. Nothing had run
 * the suites against the merge commit.
 *
 * The decision is separated from both the HTTP layer and storage so it can be
 * tested exhaustively, and so every refusal has a name a caller can act on.
 */

/**
 * Which security profiles are a claim about the integrated candidate.
 *
 * `fast` states that the evidence is the proof already on the head — work done
 * before the branch was integrated — and merging on it is what that policy asks
 * for, not a shortcut. Every other profile claims something was run against the
 * integration itself, and that claim needs a verifier result to be true.
 */
export function requiresIntegratedRun(securityProfile: string): boolean {
  return securityProfile !== "fast";
}

export type CandidateRefusal =
  | "CANDIDATE_NOT_VERIFIED"
  | "CANDIDATE_TREE_MISMATCH"
  | "CANDIDATE_SHA_MISMATCH"
  | "CANDIDATE_BASE_MOVED"
  | "CANDIDATE_REJECTED"
  | "CANDIDATE_DIGEST_MISMATCH"
  | "CANDIDATE_POLICY_MISMATCH"
  | "CANDIDATE_SUITE_NOT_PASSED"
  | "CANDIDATE_SUITES_INCOMPLETE"
  | "CANDIDATE_VERIFIER_NOT_PINNED";

export interface CandidateExpectation {
  readonly candidateTreeOid: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  /** The suites the active policy requires. A verdict missing one proves less. */
  readonly requiredSuites: readonly string[];
  readonly policyDigest: string;
  /** The verifier workflow the repository pinned. */
  readonly workflowRef: string;
  /** The exact revision, or null for any revision of that path on the default branch. */
  readonly workflowSha: string | null;
}

export type CandidateDecision =
  | { readonly ok: true; readonly resultDigest: string }
  | { readonly ok: false; readonly code: CandidateRefusal; readonly detail: string };

/**
 * The digest of a verdict, computed from its content.
 *
 * The merge gate recomputes this instead of trusting the stored field, so a
 * verdict whose suites or outcome were edited after the fact no longer matches
 * the digest that goes into the transition chain.
 */
export async function candidateResultDigest(input: {
  readonly candidateTreeOid: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
  readonly accepted: boolean;
  readonly suites: readonly CandidateSuite[];
  readonly reasonCodes: readonly string[];
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
}): Promise<string> {
  return recordDigest({
    predicate: "urn:thwip:queue:candidate-verdict:v1",
    candidateTreeOid: input.candidateTreeOid,
    candidateSha: input.candidateSha,
    baseSha: input.baseSha,
    policyDigest: input.policyDigest,
    accepted: input.accepted,
    // Sorted, so two runs that report the same suites in a different order agree.
    suites: [...input.suites]
      .map((s) => ({ name: s.name, outcome: s.outcome, durationMs: s.durationMs }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    reasonCodes: [...input.reasonCodes].sort(),
    workflowRef: input.workflowRef,
    workflowSha: input.workflowSha,
    runId: input.runId,
  });
}

export async function decideCandidate(
  verdict: CandidateVerdict | null,
  expected: CandidateExpectation,
): Promise<CandidateDecision> {
  if (verdict === null) {
    return {
      ok: false,
      code: "CANDIDATE_NOT_VERIFIED",
      detail: `no verifier result for candidate tree ${expected.candidateTreeOid}`,
    };
  }

  // The tree is the identity of the integration. Everything else is a
  // cross-check, but a verdict about another tree is about other code.
  if (verdict.candidateTreeOid !== expected.candidateTreeOid) {
    return { ok: false, code: "CANDIDATE_TREE_MISMATCH", detail: "the verdict names another tree" };
  }
  if (verdict.candidateSha !== expected.candidateSha) {
    return { ok: false, code: "CANDIDATE_SHA_MISMATCH", detail: "the verdict names another candidate commit" };
  }
  // The same tree can be reached from a different base after a fast-forward. The
  // suites passing there does not establish they pass here.
  if (verdict.baseSha !== expected.baseSha) {
    return {
      ok: false,
      code: "CANDIDATE_BASE_MOVED",
      detail: `verified against base ${verdict.baseSha}, merging onto ${expected.baseSha}`,
    };
  }

  if (
    verdict.workflowRef !== expected.workflowRef ||
    (expected.workflowSha !== null && verdict.workflowSha !== expected.workflowSha)
  ) {
    return {
      ok: false,
      code: "CANDIDATE_VERIFIER_NOT_PINNED",
      detail: "the verdict came from a workflow this repository has not pinned",
    };
  }

  if (verdict.policyDigest !== expected.policyDigest) {
    return {
      ok: false,
      code: "CANDIDATE_POLICY_MISMATCH",
      detail: "the policy changed after the candidate was verified",
    };
  }

  const recomputed = await candidateResultDigest(verdict);
  if (recomputed !== verdict.resultDigest) {
    return {
      ok: false,
      code: "CANDIDATE_DIGEST_MISMATCH",
      detail: "the stored verdict does not match its own digest",
    };
  }

  if (!verdict.accepted) {
    return {
      ok: false,
      code: "CANDIDATE_REJECTED",
      detail: verdict.reasonCodes.length > 0 ? verdict.reasonCodes.join(", ") : "the verifier refused",
    };
  }

  // An accepted verdict that skipped a required suite has not established what
  // the policy asks for, whatever it says about itself.
  const byName = new Map(verdict.suites.map((s) => [s.name, s]));
  const missing = expected.requiredSuites.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "CANDIDATE_SUITES_INCOMPLETE",
      detail: `no result for required suite(s): ${missing.join(", ")}`,
    };
  }
  const notPassed = expected.requiredSuites.filter((name) => byName.get(name)!.outcome !== "passed");
  if (notPassed.length > 0) {
    return {
      ok: false,
      code: "CANDIDATE_SUITE_NOT_PASSED",
      detail: `required suite(s) did not pass: ${notPassed.join(", ")}`,
    };
  }

  return { ok: true, resultDigest: verdict.resultDigest };
}
