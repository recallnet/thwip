import { acceptedReceiptFor, issuedAssignmentForAttempt } from "./assignment-store.js";
import type { D1Like } from "./projection.js";
import { requiresDeviceOnly } from "./runners.js";

/**
 * Whether a merge may proceed on what the developer's machine actually did.
 *
 * `fresh` and `audited` mean the required suites ran, for this turn, against the
 * integrated candidate, on a device the queue dispatched to. Issuing an
 * assignment and accepting a receipt buys nothing unless a merge without them is
 * refused, so this is the refusal, and the walk to a merge write cannot be
 * performed without calling it: `MergeEvidence` carries a brand no other module
 * can produce, and `walkToMergeReady` demands one. A route cannot forget to ask,
 * and cannot answer the question itself with a value it made up.
 *
 * That shape is deliberate. The run lease shipped enforcing nothing because a
 * correct check was reachable only through an argument every caller left empty.
 * Here the only way to obtain the argument is to read the stored receipt.
 *
 * What this function decides is whether a receipt exists and is about this
 * candidate. Whether it came from the device that claimed this attempt is
 * decided against the queue document, in `walkToMergeReady`, because the
 * document is what says who claimed the offer.
 */

declare const readFromStorage: unique symbol;

export interface LocalRun {
  readonly assignmentDigest: string;
  readonly receiptDigest: string;
  readonly candidateTreeOid: string;
  readonly deviceKeyId: string;
}

export interface MergeEvidence {
  readonly [readFromStorage]: true;
  /** Null where the profile dispatches no work to a device, which is not a weaker merge, it is a different one. */
  readonly localRun: LocalRun | null;
}

export type LocalRunRefusal =
  | "INTEGRATION_ASSIGNMENT_MISSING"
  | "INTEGRATION_RECEIPT_MISSING"
  | "INTEGRATION_RECEIPT_TREE_MISMATCH";

export type MergeEvidenceVerdict =
  | { readonly ok: true; readonly evidence: MergeEvidence }
  | { readonly ok: false; readonly code: LocalRunRefusal; readonly detail: string };

function evidence(localRun: LocalRun | null): MergeEvidence {
  return { localRun } as MergeEvidence;
}

/**
 * The evidence a merge may be walked on, read from storage.
 *
 * A profile that dispatches nothing to a device answers with no local run,
 * which is what `fast` and `remote` have always merged on. `fresh` and
 * `audited` answer with the accepted receipt or they refuse.
 */
export async function localRunEvidenceFor(
  db: D1Like,
  input: {
    readonly securityProfile: string | null;
    readonly attemptId: string;
    /** The tree this merge is about, from the caller that is about to write it. */
    readonly candidateTreeOid: string;
  },
): Promise<MergeEvidenceVerdict> {
  if (!requiresDeviceOnly(input.securityProfile)) return { ok: true, evidence: evidence(null) };

  const receipt = await acceptedReceiptFor(db, input.attemptId);
  if (receipt === null) {
    // Told apart on purpose. Nothing was ever dispatched is an offer the device
    // never claimed; dispatched and unanswered is a run still going, or a
    // machine that closed its laptop. The first needs a runner, the second needs
    // time or a new turn, and one code for both would hide which.
    const assignment = await issuedAssignmentForAttempt(db, input.attemptId);
    return assignment === null
      ? {
          ok: false,
          code: "INTEGRATION_ASSIGNMENT_MISSING",
          detail: "this profile runs the integration on a device, and no device was ever assigned this attempt",
        }
      : {
          ok: false,
          code: "INTEGRATION_RECEIPT_MISSING",
          detail: "the device holding this attempt has not returned a signed integration receipt",
        };
  }

  if (receipt.candidateTreeOid !== input.candidateTreeOid) {
    return {
      ok: false,
      code: "INTEGRATION_RECEIPT_TREE_MISMATCH",
      detail: "the accepted receipt is about a different tree than the one being merged",
    };
  }

  return {
    ok: true,
    evidence: evidence({
      assignmentDigest: receipt.assignmentDigest,
      receiptDigest: receipt.receiptDigest,
      candidateTreeOid: receipt.candidateTreeOid,
      deviceKeyId: receipt.deviceKeyId,
    }),
  };
}
