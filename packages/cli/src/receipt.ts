import { QUEUE_PREDICATE_TYPES, QUEUE_SIGN_NAMESPACE, canonicalRecordBytes, queueSigningBytes } from "@thwip/queue-protocol";
import { signSsh } from "@thwip/sshsig";

/**
 * What a device sends back after it has run the candidate.
 *
 * The receipt is the only thing the queue has to go on, so it is signed by the
 * same device key the assignment was addressed to. The bytes under the
 * signature are domain-separated by the integration-run predicate, which is
 * what stops a signature over one kind of thwip record being replayed as
 * another.
 *
 * The service checks this signature. Both sides therefore have to agree on
 * exactly which bytes it covers, and that agreement is the canonical JSON of
 * the receipt without its own signature, wrapped in the same pre-authentication
 * encoding every other queue record uses.
 */

export interface ReceiptSuiteOutcome {
  readonly name: string;
  readonly outcome: "passed" | "failed";
}

export interface UnsignedReceipt {
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly suites: readonly ReceiptSuiteOutcome[];
}

export interface SignedReceipt extends UnsignedReceipt {
  readonly signature: string;
}

/**
 * Build the receipt from the assignment that was checked, so the tree it
 * reports is the tree that was signed rather than anything a caller carries
 * alongside.
 */
export function unsignedReceipt(
  assignment: { readonly assignmentId: string; readonly assignmentDigest: string; readonly candidateTreeOid: string },
  deviceKeyId: string,
  suites: readonly ReceiptSuiteOutcome[],
): UnsignedReceipt {
  return {
    assignmentId: assignment.assignmentId,
    assignmentDigest: assignment.assignmentDigest,
    candidateTreeOid: assignment.candidateTreeOid,
    deviceKeyId,
    suites,
  };
}

export function receiptSigningBytes(receipt: UnsignedReceipt): Uint8Array {
  return queueSigningBytes(QUEUE_PREDICATE_TYPES.integrationRun, canonicalRecordBytes(receipt));
}

export async function signReceipt(receipt: UnsignedReceipt, privateKeyPath: string): Promise<SignedReceipt> {
  const signature = await signSsh({
    privateKeyPath,
    namespace: QUEUE_SIGN_NAMESPACE,
    message: receiptSigningBytes(receipt),
  });
  return { ...receipt, signature };
}
