import type { JSONWebKeySet } from "jose";
import { parseClaimResponse, verifyClaimedAssignment } from "./assignment.js";
import type { CandidateRefusal, CandidateWorkspace } from "./candidate.js";
import { unsignedReceipt, type ReceiptSuiteOutcome, type SignedReceipt, type UnsignedReceipt } from "./receipt.js";

/**
 * One turn under `fresh`, from the offer to the signed receipt.
 *
 * The order is the security property. The assignment is checked against the
 * keys thwip publishes before anything is fetched, the candidate is put on
 * disk before anything is run, and the receipt reports what ran against the
 * tree the assignment signed. Every step reads its input from the step before
 * it, so there is nowhere for the response body to slip an instruction past
 * the signature.
 *
 * The steps that touch the network, git and the pipeline are ports. What is
 * left here is the sequence, which is the part worth testing exhaustively and
 * the part that has to keep holding.
 */

export interface FreshTurnPorts {
  /** POST /v1/queue/:repositoryId/claim */
  claim(): Promise<{ readonly status: number; readonly body: unknown }>;
  /** The keys thwip publishes, or nothing when they cannot be read. */
  publishedKeys(): Promise<JSONWebKeySet | null>;
  materialize(input: {
    readonly candidateSha: string;
    readonly candidateTreeOid: string;
  }): Promise<{ ok: true; workspace: CandidateWorkspace } | CandidateRefusal>;
  runSuites(
    workspace: CandidateWorkspace,
    suites: readonly string[],
  ): Promise<readonly ReceiptSuiteOutcome[]>;
  signReceipt(receipt: UnsignedReceipt): Promise<SignedReceipt>;
  /** POST /v1/queue/:repositoryId/receipt */
  submit(receipt: SignedReceipt): Promise<{ readonly status: number; readonly body: unknown }>;
  now(): string;
}

export interface FreshTurnContext {
  readonly deviceKeyId: string;
  readonly repositoryId: string;
  readonly attemptId: string;
}

export type FreshTurnResult =
  | { readonly ok: true; readonly candidateTreeOid: string }
  | { readonly ok: false; readonly reasonCode: string; readonly detail: string };

export async function runFreshTurn(
  context: FreshTurnContext,
  ports: FreshTurnPorts,
): Promise<FreshTurnResult> {
  // Fetched before the claim, because an assignment this machine cannot check
  // is one it must not act on, and finding that out after claiming would hold
  // the lane for a turn nobody can run.
  const jwks = await ports.publishedKeys();
  if (jwks === null) {
    return refused("SERVICE_UNAVAILABLE", "thwip's published keys could not be read, so no assignment could be checked");
  }

  const claimed = await ports.claim();
  if (claimed.status !== 200) {
    return refused(reasonFrom(claimed.body, claimed.status), `the queue refused this claim (${claimed.status})`);
  }
  const envelope = parseClaimResponse(claimed.body);
  if (envelope === null) {
    return refused("ASSIGNMENT_UNVERIFIED", "the queue answered the claim with something this thwip cannot read");
  }

  const verified = await verifyClaimedAssignment(envelope, {
    jwks,
    deviceKeyId: context.deviceKeyId,
    repositoryId: context.repositoryId,
    attemptId: context.attemptId,
    now: ports.now(),
  });
  if (!verified.ok) return refused(verified.reasonCode, verified.detail);

  const materialized = await ports.materialize({
    candidateSha: verified.candidateSha,
    candidateTreeOid: verified.candidateTreeOid,
  });
  if (!materialized.ok) return refused(materialized.reasonCode, materialized.detail);

  const workspace = materialized.workspace;
  let suites: readonly ReceiptSuiteOutcome[];
  try {
    suites = await ports.runSuites(workspace, verified.requiredSuites);
  } finally {
    // The candidate comes off the disk whatever happened, including a pipeline
    // that threw. A worktree left behind after a failed turn is a worktree the
    // developer finds later and cannot account for.
    await workspace.dispose();
  }

  // Sent as it happened, failures and all. A device that reports only its
  // successes is a device whose receipts say nothing, and the queue is the one
  // that decides what a failure costs.
  const receipt = await ports.signReceipt(unsignedReceipt(verified, context.deviceKeyId, suites));
  const submitted = await ports.submit(receipt);
  if (submitted.status !== 200) {
    return refused(
      reasonFrom(submitted.body, submitted.status),
      `the queue refused this receipt (${submitted.status})`,
    );
  }
  if ((submitted.body as { accepted?: unknown } | null)?.accepted !== true) {
    return refused("RECEIPT_REJECTED", "the queue answered without accepting the receipt");
  }

  return { ok: true, candidateTreeOid: verified.candidateTreeOid };
}

/**
 * The service's own word for what it refused, kept verbatim. A code this build
 * does not know is passed through rather than translated: `exitCodeFor` already
 * files an unknown code under the class that makes a person look, and inventing
 * a local meaning for a newer service's refusal is how a developer ends up
 * fixing the wrong thing.
 */
function reasonFrom(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    for (const field of ["reason", "error", "reasonCode"]) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return status >= 500 ? "SERVICE_UNAVAILABLE" : "INTERNAL_FAILURE";
}

function refused(reasonCode: string, detail: string): FreshTurnResult {
  return { ok: false, reasonCode, detail };
}
