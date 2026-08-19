/**
 * The ports every queue-route test has to hand `queueRoutes`, in one place.
 *
 * Each test file used to paste the same dozen stubs into its own `app()`
 * helper: the same authenticated session, the same OIDC claim, the same
 * enforced project, the same sponsor lookup. Twenty-two copies of one object,
 * so a port added to the routes was a port added to twenty-two files, and a
 * file that missed one got the behaviour of a port that answers nothing rather
 * than a failure that says which stub is absent. `integratedCandidate` is the
 * one that caught fire: a walk that reaches GitHub reads null where the stub is
 * missing and every test in the file refuses with `BASE_UNREADABLE`.
 *
 * A file overrides what its own subject is about and inherits the rest.
 */

import { provenCommit } from "./proven-commit.js";

const forty = (c: string): string => c.repeat(40);

/**
 * Shas a file that does not care about them can take as given.
 *
 * Hex, because they are object ids and the statement parser that reads a
 * proof's subject refuses anything that is not one. A tree of forty `t`s reads
 * as a head carrying no proof at all, which is a refusal three gates further on
 * that says nothing about the letter that caused it.
 */
export const FIXTURE_BASE = forty("b");
export const FIXTURE_TREE = forty("7");
export const FIXTURE_CANDIDATE = forty("c");

export interface QueueDepsPins {
  /** The repository every route in the file is asked about. */
  repositoryId: string;
  baseRef?: string;
  baseSha?: string;
  treeOid?: string;
  candidateSha?: string;
  /**
   * The head GitHub says a pull request is on. It answers per pull request
   * because a file that runs several through one queue gives each its own head,
   * and a candidate whose head is not the entry's head is `HEAD_MOVED`.
   */
  headShaFor?: (pullRequestNumber: number) => string;
  /** Who the session belongs to. */
  principalId?: string;
  githubUserId?: string;
  isAdmin?: boolean;
  /** Current lifecycle incarnation of the repository fixture. */
  projectId?: string;
}

/** A `fast` policy with one required suite, which is what most files run under. */
export function fixturePolicy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyDigest: `sha256:${"b".repeat(64)}`,
    pipelineDigest: `sha256:${"c".repeat(64)}`,
    requiredSuites: ["unit"],
    securityProfile: "fast",
    organizationId: "org_1",
    projectId: "proj_1",
    verifier: null,
    ...over,
  };
}

/**
 * Every port `queueRoutes` takes, answered the way a repository with nothing
 * wrong with it answers, with the file's own overrides spread last.
 */
export function queueRouteDeps(
  pins: QueueDepsPins,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const baseRef = pins.baseRef ?? "refs/heads/main";
  const baseSha = pins.baseSha ?? FIXTURE_BASE;
  const treeOid = pins.treeOid ?? FIXTURE_TREE;
  const candidateSha = pins.candidateSha ?? FIXTURE_CANDIDATE;
  const headShaFor = pins.headShaFor ?? ((pr: number) => String(pr).padStart(40, "a"));
  const githubUserId = pins.githubUserId ?? "1";
  return {
    authenticate: async () => ({
      ok: true,
      principalId: pins.principalId ?? "alice",
      githubUserId,
      isAdmin: pins.isAdmin ?? true,
    }),
    verifyOidc: async () => ({ repository_id: pins.repositoryId }),
    pinnedVerifier: async () => null,
    activePolicy: async () => fixturePolicy(),
    proofCheckRunId: async () => "778899",
    signRecordBytes: async (_e: unknown, bytes: Uint8Array) => `jws.${bytes.byteLength}`,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({
      activationState: "enforced",
      projectId: pins.projectId ?? "proj_1",
      verifierProtocol: 3,
    }),
    principalFor: async (_e: unknown, _repositoryId: string, userId: string) => `principal_${userId}`,
    pullRequestPlacement: async (_e: unknown, _r: string, pullRequestNumber: number) => ({
      authorGithubUserId: githubUserId,
      baseRef,
      authorIsBot: false,
      draft: false,
      headSha: headShaFor(pullRequestNumber),
    }),
    mergeWrite: async () => ({ kind: "unknown", detail: "the test did not provide a merge result" }),
    scheduleMergeReconciliation: async () => {},
    pullRequestMergeState: async () => ({ merged: false, mergeCommitSha: null }),
    publishTurnCheck: async () => {},
    // A head that carries a readable proof, because the walk to a merge reads
    // the trailer to cite it and a head without one refuses with
    // WORK_RECEIPT_UNREADABLE. That is the normal case, so it is the default.
    commitFacts: async () => ({
      treeOid,
      parentShas: [baseSha],
      message: provenCommit({ repositoryId: pins.repositoryId, baseRef, treeOid, baseSha }),
    }),
    // The candidate GitHub has integrated, which is where the walk to a merge
    // reads the base it pins. Absent, this answers null and every turn in the
    // file refuses, which is why it belongs in the shared defaults.
    integratedCandidate: async (_e: unknown, _r: string, _ref: string, pullRequestNumber: number) => ({
      status: "pinned",
      baseSha,
      headSha: headShaFor(pullRequestNumber),
      candidateSha,
      candidateTreeOid: treeOid,
    }),
    sleep: async () => {},
    ...over,
  };
}
