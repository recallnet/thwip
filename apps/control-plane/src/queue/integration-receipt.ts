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
