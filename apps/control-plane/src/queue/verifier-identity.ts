/**
 * Who is allowed to say "verified" (plan.md §17).
 *
 * The existing control plane accepts a GitHub Actions OIDC token from the right
 * repository. That is not enough for a merge decision: any workflow in the
 * repository can obtain such a token, so a contributor who can add a workflow
 * file could mint a verdict. The queue therefore pins the exact workflow — path
 * and commit — and refuses anything else.
 *
 * These are pure checks over already-verified claims. Signature verification
 * stays where it is, in the OIDC layer; this module answers the separate
 * question of whether the authenticated caller is the verifier we appointed.
 */

export interface OidcVerifierClaims {
  readonly repository_id?: unknown;
  readonly repository_owner_id?: unknown;
  /** The workflow that started the run. */
  readonly workflow_ref?: unknown;
  readonly workflow_sha?: unknown;
  /** The workflow containing the job, which differs for a reusable workflow. */
  readonly job_workflow_ref?: unknown;
  readonly job_workflow_sha?: unknown;
  readonly run_id?: unknown;
  readonly run_attempt?: unknown;
  readonly event_name?: unknown;
  readonly ref?: unknown;
  readonly jti?: unknown;
}

export interface PinnedVerifier {
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly workflowRef: string;
  /**
   * The exact revision the verifier must run from, or null for any revision of
   * `workflowRef` on the default branch.
   *
   * A run triggered by repository_dispatch executes the default branch's current
   * head, so this value changes with every merge. Pinning it exactly means
   * re-pinning after each merge, and a stale pin refuses every verdict — which
   * fails closed, but fails constantly. Null keeps the pin that carries the
   * weight: the workflow's path, on the default branch, which only a merge can
   * change and which this queue's own ruleset protects.
   */
  readonly workflowSha: string | null;
  readonly reusableWorkflowRef: string;
  readonly reusableWorkflowSha: string | null;
  /** The event the dispatch uses; anything else did not come from us (§17.1). */
  readonly expectedEventName: "repository_dispatch";
  /** The verifier must run from the default branch, never from a pull request. */
  readonly defaultBranchRef: string;
}

export type IdentityVerdict =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly runAttempt: number;
      readonly jti: string;
      /** The revision the run came from, recorded even when it is not pinned. */
      readonly workflowSha: string;
    }
  | { readonly ok: false; readonly reason: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A decimal id may arrive as a JSON number; it is compared as a string because
 * GitHub ids exceed the safe integer range in general.
 */
function decimal(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export function verifyVerifierIdentity(claims: OidcVerifierClaims, pinned: PinnedVerifier): IdentityVerdict {
  const repositoryId = decimal(claims.repository_id);
  if (repositoryId === null) return { ok: false, reason: "token has no repository_id" };
  if (repositoryId !== pinned.repositoryId) return { ok: false, reason: "token is for another repository" };

  const ownerId = decimal(claims.repository_owner_id);
  if (ownerId === null) return { ok: false, reason: "token has no repository_owner_id" };
  if (ownerId !== pinned.repositoryOwnerId) return { ok: false, reason: "token is for another owner" };

  // The pin that matters. Any workflow in the repository can get a token for the
  // repository, so the workflow path and its commit are what authorize a verdict.
  const workflowRef = str(claims.workflow_ref);
  if (workflowRef === null) return { ok: false, reason: "token has no workflow_ref" };
  if (workflowRef !== pinned.workflowRef) {
    return { ok: false, reason: `workflow_ref ${workflowRef} is not the pinned verifier` };
  }
  const workflowSha = str(claims.workflow_sha);
  if (workflowSha === null) return { ok: false, reason: "token has no workflow_sha" };
  if (pinned.workflowSha !== null && workflowSha !== pinned.workflowSha) {
    return { ok: false, reason: "workflow_sha is not the pinned verifier commit" };
  }

  // job_workflow_ref names the file the job itself came from. When the verifier
  // calls a reusable workflow, this is the reusable one, and it must be pinned
  // too or the outer workflow could call anything.
  const jobWorkflowRef = str(claims.job_workflow_ref);
  if (jobWorkflowRef === null) return { ok: false, reason: "token has no job_workflow_ref" };
  if (jobWorkflowRef !== pinned.reusableWorkflowRef) {
    return { ok: false, reason: `job_workflow_ref ${jobWorkflowRef} is not the pinned reusable workflow` };
  }
  const jobWorkflowSha = str(claims.job_workflow_sha);
  if (jobWorkflowSha === null) return { ok: false, reason: "token has no job_workflow_sha" };
  if (pinned.reusableWorkflowSha !== null && jobWorkflowSha !== pinned.reusableWorkflowSha) {
    return { ok: false, reason: "job_workflow_sha is not the pinned reusable workflow commit" };
  }

  const eventName = str(claims.event_name);
  if (eventName !== pinned.expectedEventName) {
    return { ok: false, reason: `event ${String(eventName)} did not come from a queue dispatch` };
  }

  // A run triggered on a pull request ref would execute contributor-controlled
  // configuration; the verifier only runs from the default branch (§17.1).
  const ref = str(claims.ref);
  if (ref !== pinned.defaultBranchRef) {
    return { ok: false, reason: `run ref ${String(ref)} is not the default branch` };
  }

  const runId = decimal(claims.run_id);
  if (runId === null) return { ok: false, reason: "token has no run_id" };
  const runAttempt = decimal(claims.run_attempt);
  if (runAttempt === null) return { ok: false, reason: "token has no run_attempt" };
  const jti = str(claims.jti);
  if (jti === null) return { ok: false, reason: "token has no jti" };

  return { ok: true, runId, runAttempt: Number(runAttempt), jti, workflowSha };
}

/**
 * One verdict per attempt and nonce (plan.md §23.1). The jti gives a second,
 * independent replay guard: the same token can never be presented twice, even
 * for the same attempt.
 */
export interface CallbackLedger {
  seen(jti: string): boolean;
  remember(jti: string, attemptId: string): void;
}

export type CallbackAcceptance =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string; readonly code: "REPLAYED_TOKEN" | "NONCE_MISMATCH" | "STALE_ATTEMPT" };

export function acceptCallback(input: {
  readonly ledger: CallbackLedger;
  readonly jti: string;
  readonly attemptId: string;
  readonly nonce: string;
  readonly expected: { readonly attemptId: string; readonly nonce: string } | null;
}): CallbackAcceptance {
  if (input.ledger.seen(input.jti)) {
    return { accepted: false, reason: "this OIDC token was already used", code: "REPLAYED_TOKEN" };
  }
  if (input.expected === null || input.expected.attemptId !== input.attemptId) {
    return { accepted: false, reason: "no live attempt is awaiting this result", code: "STALE_ATTEMPT" };
  }
  if (input.expected.nonce !== input.nonce) {
    return { accepted: false, reason: "nonce does not match the issued verification", code: "NONCE_MISMATCH" };
  }
  input.ledger.remember(input.jti, input.attemptId);
  return { accepted: true };
}
