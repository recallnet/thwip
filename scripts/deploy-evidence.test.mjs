import { describe, expect, it } from "vitest";

import { evaluateDeployEvidence, waitForDeployEvidence } from "./deploy-evidence.mjs";

const SHA = "a".repeat(40);
const record = (kind = "reused-proof-merge", sha = SHA) => ({
  digest: `sha256:${"d".repeat(64)}`,
  sequence: 228,
  record: {
    kind,
    after: { baseSha: sha },
    observedAt: "2026-08-11T12:00:00Z",
    ...(kind === "reused-proof-merge"
      ? { reusedProof: { pullRequestNumber: 341, attemptId: "att-341" } }
      : kind === "verified-merge"
        ? { verifiedMerge: { pullRequestNumber: 341, attemptId: "att-341" } }
        : kind === "candidate-verified-merge"
          ? { candidateVerified: { pullRequestNumber: 341, attemptId: "att-341" } }
          : kind === "override-merge"
            ? { override: { pullRequestNumber: 341, attemptId: "att-341" } }
            : {}),
  },
});
const report = (over = {}) => ({
  epochStartsAt: 169,
  result: { findings: [], signaturesChecked: 60 },
  records: [record()],
  ...over,
});

describe("the exact merge evidence required for a deploy", () => {
  it.each(["verified-merge", "reused-proof-merge", "candidate-verified-merge"])(
    "accepts a signed %s record for the landed SHA",
    (kind) => {
      expect(evaluateDeployEvidence(report({ records: [record(kind)] }), SHA)).toMatchObject({
        status: "accepted",
        evidence: { kind, sha: SHA, pullRequestNumber: 341, sequence: 228 },
      });
    },
  );

  it("refuses an override record", () => {
    expect(evaluateDeployEvidence(report({ records: [record("override-merge")] }), SHA)).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/override/),
    });
  });

  it("refuses an external movement even when it names the exact SHA", () => {
    expect(evaluateDeployEvidence(report({ records: [record("external-transition")] }), SHA)).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/not a verified merge/),
    });
  });

  it("refuses a matching record outside the range whose signatures were checked", () => {
    expect(
      evaluateDeployEvidence(report({ epochStartsAt: 229 }), SHA),
    ).toMatchObject({ status: "refused", reason: expect.stringMatching(/outside the signed range/) });
  });

  it("waits when publication has not reached the independently checked head", () => {
    expect(
      evaluateDeployEvidence(
        report({
          records: [],
          result: {
            findings: [{ code: "CHAIN_BEHIND_HEAD", detail: "chain ends before main" }],
            signaturesChecked: 59,
          },
        }),
        SHA,
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("refuses a broken chain before looking at its record", () => {
    expect(
      evaluateDeployEvidence(
        report({ result: { findings: [{ code: "BAD_SIGNATURE", detail: "signature is invalid" }], signaturesChecked: 60 } }),
        SHA,
      ),
    ).toMatchObject({ status: "refused", reason: expect.stringMatching(/BAD_SIGNATURE/) });
  });

  it("retries publication and returns the evidence that appears", async () => {
    let checks = 0;
    let clock = 0;
    const result = await waitForDeployEvidence({
      check: async () => (++checks === 1 ? { status: "pending", reason: "not published" } : { status: "accepted" }),
      sleep: async () => {
        clock += 10;
      },
      now: () => clock,
      intervalMs: 10,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ status: "accepted", attempt: 2 });
  });
});
