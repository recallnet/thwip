/**
 * The runner's account of what it ran, checked against what it was asked to run.
 *
 * A receipt is only evidence if it is about *this* assignment and *this* tree.
 * One about a different tree is an account of different code, and accepting it
 * would certify a candidate on the strength of a run that never touched it. One
 * naming a different assignment answers a question nobody asked. One signed by
 * a device other than the one the assignment was issued to is not the runner
 * the queue dispatched to, because an assignment names its runner.
 *
 * This function is pure: no network, no storage, no signature verification. It
 * assumes its caller has already checked the receipt's JWS against the device
 * key the assignment names — that check needs key material this function must
 * never see, so it stays with the caller.
 */

import { canonicalBytes, envelopeDigest, type Sha256 } from "@thwip/queue-protocol";

/**
 * The namespace the device signs a receipt under.
 *
 * Separate from the proof namespace on purpose. A signature is only evidence of
 * what it was made for, and reusing `thwip-ci-dsse-v1` would let a proof
 * signature be replayed as a receipt for whatever assignment happened to hash
 * the same way.
 */
export const INTEGRATION_RECEIPT_NAMESPACE = "thwip-integration-receipt-v1";

/**
 * The exact bytes a device signs and the queue verifies.
 *
 * Built from the five fields that decide the receipt and nothing else, with
 * object keys in a fixed order, so the signer and the verifier cannot disagree
 * about what was signed. The suites keep the order the device sent them in:
 * that is part of its account, and reordering would verify a different message.
 */
export function integrationReceiptBytes(receipt: SubmittedReceipt): Uint8Array {
  return canonicalBytes(
    JSON.stringify({
      assignmentDigest: receipt.assignmentDigest,
      assignmentId: receipt.assignmentId,
      candidateTreeOid: receipt.candidateTreeOid,
      deviceKeyId: receipt.deviceKeyId,
      suites: receipt.suites.map((s) => ({ name: s.name, outcome: s.outcome })),
    }),
  );
}

/** The digest of those bytes, which is what a merge record cites. */
export function integrationReceiptDigest(receipt: SubmittedReceipt): Promise<Sha256> {
  return envelopeDigest(integrationReceiptBytes(receipt));
}

export interface SubmittedReceiptSuite {
  readonly name: string;
  readonly outcome: string;
}

export interface SubmittedReceipt {
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly suites: readonly SubmittedReceiptSuite[];
}

export interface IssuedAssignment {
  readonly assignmentId: string;
  readonly digest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly requiredSuites: readonly string[];
}

export type ReceiptVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "ASSIGNMENT_MISMATCH"
        | "CANDIDATE_TREE_MISMATCH"
        | "DEVICE_MISMATCH"
        | "SUITE_MISSING"
        | "SUITE_FAILED";
      readonly detail: string;
    };

export function acceptIntegrationReceipt(receipt: SubmittedReceipt, assignment: IssuedAssignment): ReceiptVerdict {
  if (receipt.assignmentId !== assignment.assignmentId || receipt.assignmentDigest !== assignment.digest) {
    return { ok: false, code: "ASSIGNMENT_MISMATCH", detail: "this receipt is about a different assignment" };
  }
  if (receipt.candidateTreeOid !== assignment.candidateTreeOid) {
    return {
      ok: false,
      code: "CANDIDATE_TREE_MISMATCH",
      detail: "this receipt is about a different tree than the one being merged",
    };
  }
  if (receipt.deviceKeyId !== assignment.deviceKeyId) {
    return {
      ok: false,
      code: "DEVICE_MISMATCH",
      detail: "this receipt was signed by a device other than the one the assignment was issued to",
    };
  }
  for (const required of assignment.requiredSuites) {
    const ran = receipt.suites.find((s) => s.name === required);
    if (ran === undefined) {
      return { ok: false, code: "SUITE_MISSING", detail: `required suite ${required} did not run` };
    }
    if (ran.outcome !== "passed") {
      return { ok: false, code: "SUITE_FAILED", detail: `required suite ${required} ${ran.outcome}` };
    }
  }
  return { ok: true };
}
