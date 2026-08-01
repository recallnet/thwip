import { QUEUE_PREDICATE_TYPES, canonicalRecordBytes } from "@thwip/queue-protocol";
import { dssePae } from "@thwip/protocol";
import { describe, expect, it } from "vitest";
import { receiptSigningBytes, unsignedReceipt } from "./receipt.js";

/**
 * The bytes the device signs are the only thing the service can check, so what
 * they are is a contract, not an implementation detail. These tests pin it.
 */

const RECEIPT = {
  assignmentId: "asg-1",
  assignmentDigest: `sha256:${"a".repeat(64)}`,
  candidateTreeOid: "4".repeat(40),
  deviceKeyId: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  suites: [
    { name: "lint", outcome: "passed" as const },
    { name: "test", outcome: "passed" as const },
  ],
};

describe("the receipt a device signs", () => {
  it("signs the fields it sends and nothing else", () => {
    const bytes = receiptSigningBytes(RECEIPT);
    expect(bytes).toEqual(dssePae(QUEUE_PREDICATE_TYPES.integrationRun, canonicalRecordBytes(RECEIPT)));
  });

  it("separates itself from every other record thwip signs", () => {
    const decoded = new TextDecoder().decode(receiptSigningBytes(RECEIPT));
    expect(decoded).toContain(QUEUE_PREDICATE_TYPES.integrationRun);
    expect(decoded).not.toContain(QUEUE_PREDICATE_TYPES.integrationAssignment);
  });

  it("changes when the tree that was run changes", () => {
    const other = receiptSigningBytes({ ...RECEIPT, candidateTreeOid: "5".repeat(40) });
    expect(other).not.toEqual(receiptSigningBytes(RECEIPT));
  });

  it("changes when a suite outcome changes", () => {
    const failed = receiptSigningBytes({
      ...RECEIPT,
      suites: [
        { name: "lint", outcome: "passed" as const },
        { name: "test", outcome: "failed" as const },
      ],
    });
    expect(failed).not.toEqual(receiptSigningBytes(RECEIPT));
  });

  it("reports the tree the assignment signed, never the one a caller passes beside it", () => {
    const receipt = unsignedReceipt(
      {
        assignmentId: "asg-1",
        assignmentDigest: RECEIPT.assignmentDigest,
        candidateTreeOid: RECEIPT.candidateTreeOid,
      },
      RECEIPT.deviceKeyId,
      RECEIPT.suites,
    );
    expect(receipt).toEqual(RECEIPT);
  });
});
