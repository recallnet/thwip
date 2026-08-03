import { QUEUE_PREDICATE_TYPES, canonicalRecordBytes, queueSigningBytes } from "./canonical.js";

/**
 * The five fields that are a device's integration receipt.
 *
 * The device signs these and the queue verifies that signature, from different
 * packages. They agreed once by coincidence: the command line tool signed
 * whatever its receipt object held, and the control plane signed five fields it
 * picked out again by hand. Adding a field on either side would have refused
 * every receipt, with both packages' own tests still green, because neither
 * could see the other.
 *
 * A receipt carries no log text, environment variables, absolute paths, source,
 * or secrets.
 */
export interface IntegrationReceiptFields {
  readonly assignmentId: string;
  readonly assignmentDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
  readonly suites: readonly { readonly name: string; readonly outcome: string }[];
}

/** Exactly what is signed: the receipt as content, and nothing sent alongside it. */
export function integrationReceiptContent(receipt: IntegrationReceiptFields): Record<string, unknown> {
  return {
    assignmentId: receipt.assignmentId,
    assignmentDigest: receipt.assignmentDigest,
    candidateTreeOid: receipt.candidateTreeOid,
    deviceKeyId: receipt.deviceKeyId,
    suites: receipt.suites.map((s) => ({ name: s.name, outcome: s.outcome })),
  };
}

/**
 * The bytes a device signs and the queue verifies.
 *
 * The pre-authentication encoding names the integration-run predicate, which is
 * what stops a signature over one kind of thwip record being replayed as
 * another.
 */
export function integrationReceiptSigningBytes(receipt: IntegrationReceiptFields): Uint8Array {
  return queueSigningBytes(QUEUE_PREDICATE_TYPES.integrationRun, canonicalRecordBytes(integrationReceiptContent(receipt)));
}
