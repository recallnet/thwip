import type { GitSubject, IntegrationAssignmentV1, Sha256 } from "@thwip/queue-protocol";
import { buildAssignment, signAssignment, type SignedRecord, type Signer } from "./evidence.js";

/**
 * The queue telling a developer's own machine what to run, signed.
 *
 * This is what `fresh` (and `audited`'s local half) means, and what nothing
 * produced until now, which is why a verified merge was unreachable and why
 * both profiles were refused. A local run has no GitHub workflow to pin, so
 * the assignment it builds carries no `verifier` — that field belongs to the
 * `remote` execution mode only. The policy is bound by digesting the document
 * rather than trusting a digest handed alongside it, so an assignment cannot
 * claim to bind a policy nobody actually resolved.
 */
export async function signLocalRunAssignment(input: {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly git: GitSubject;
  readonly queue: {
    readonly queueEpoch: number;
    readonly turnSequence: number;
    readonly entryId: string;
    readonly pullRequestNumber: number;
    readonly sponsorPrincipalId: string;
    readonly queueDecisionDigest: Sha256;
  };
  readonly policy: {
    readonly version: number;
    /** Only `fresh` and `audited` are dispatched to a device under `mode: "run"` (§21.1). */
    readonly securityProfile: "fresh" | "audited";
    readonly requiredSuites: readonly string[];
    /** The policy document, digested here rather than trusted as a value. */
    readonly document: unknown;
  } & (
    | { readonly runner: "command" }
    | { readonly runner: "dagger"; readonly daggerModuleDigest: Sha256; readonly daggerEngineDigest: Sha256 }
  );
  readonly workReceiptDigest: Sha256;
  readonly previousTransitionDigest: Sha256 | null;
  readonly issuedAt: string;
  readonly executionSeconds: number;
  readonly nonce: string;
  readonly runnerPrincipalId: string;
  readonly deviceKeyId: string;
  readonly signer: Signer;
}): Promise<SignedRecord<IntegrationAssignmentV1> | { error: string }> {
  const doc = await buildAssignment({
    assignmentId: input.assignmentId,
    attemptId: input.attemptId,
    ownerId: input.ownerId,
    git: input.git,
    queue: input.queue,
    policy: input.policy,
    execution: {
      mode: "run",
      profile: input.policy.securityProfile,
      runnerPrincipalId: input.runnerPrincipalId,
      deviceKeyId: input.deviceKeyId,
    },
    evidence: {
      workReceiptDigest: input.workReceiptDigest,
      previousTransitionDigest: input.previousTransitionDigest,
    },
    // A local run pins no GitHub workflow, so no verifier is passed through.
    issuedAt: input.issuedAt,
    executionSeconds: input.executionSeconds,
    nonce: input.nonce,
  });
  return signAssignment(doc, input.signer);
}
