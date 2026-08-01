import { describe, expect, it } from "vitest";
import { acceptIntegrationReceipt } from "./integration-receipt.js";

/**
 * The runner's account of what it ran.
 *
 * A receipt is only worth accepting if it is about the assignment the queue
 * issued, about the tree the queue is going to merge, and signed by the device
 * the assignment named. Anything else is evidence for different work, and
 * accepting it would certify a candidate on the strength of a run that never
 * happened this way.
 */
const D = (c: string) => `sha256:${c.repeat(64)}`;
const TREE = "4".repeat(40);

const receipt = (over: Record<string, unknown> = {}) => ({
  assignmentId: "asg-1",
  assignmentDigest: D("a"),
  candidateTreeOid: TREE,
  deviceKeyId: "device-1",
  suites: [{ name: "lint", outcome: "passed", durationMs: 10 }],
  ...over,
});

const assignment = {
  assignmentId: "asg-1",
  digest: D("a"),
  candidateTreeOid: TREE,
  deviceKeyId: "device-1",
  requiredSuites: ["lint"],
};

describe("accepting an integration receipt", () => {
  it("accepts one that matches the assignment, the tree, and the device", () => {
    expect(acceptIntegrationReceipt(receipt(), assignment)).toMatchObject({ ok: true });
  });

  it("refuses a receipt naming a different assignment", () => {
    const result = acceptIntegrationReceipt(receipt({ assignmentId: "asg-2" }), assignment);
    expect(result).toMatchObject({ ok: false, code: "ASSIGNMENT_MISMATCH" });
  });

  it("refuses a receipt whose digest names a different assignment document", () => {
    const result = acceptIntegrationReceipt(receipt({ assignmentDigest: D("z") }), assignment);
    expect(result).toMatchObject({ ok: false, code: "ASSIGNMENT_MISMATCH" });
  });

  it("refuses a receipt about a different candidate tree", () => {
    const result = acceptIntegrationReceipt(receipt({ candidateTreeOid: "9".repeat(40) }), assignment);
    expect(result).toMatchObject({ ok: false, code: "CANDIDATE_TREE_MISMATCH" });
  });

  it("refuses a receipt signed by a device other than the one the assignment was issued to", () => {
    const result = acceptIntegrationReceipt(receipt({ deviceKeyId: "device-2" }), assignment);
    expect(result).toMatchObject({ ok: false, code: "DEVICE_MISMATCH" });
  });

  it("refuses a receipt missing a suite the policy required", () => {
    const result = acceptIntegrationReceipt(receipt({ suites: [] }), assignment);
    expect(result).toMatchObject({ ok: false, code: "SUITE_MISSING" });
  });

  it("refuses a receipt whose required suite did not pass", () => {
    const result = acceptIntegrationReceipt(
      receipt({ suites: [{ name: "lint", outcome: "failed", durationMs: 10 }] }),
      assignment,
    );
    expect(result).toMatchObject({ ok: false, code: "SUITE_FAILED" });
  });

  it("checks the assignment before the tree, so a mismatched assignment is not reported as a tree mismatch", () => {
    const result = acceptIntegrationReceipt(
      receipt({ assignmentId: "asg-2", candidateTreeOid: "9".repeat(40) }),
      assignment,
    );
    expect(result).toMatchObject({ ok: false, code: "ASSIGNMENT_MISMATCH" });
  });
});
