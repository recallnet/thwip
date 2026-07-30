import { describe, expect, it } from "vitest";
import { parseVerifierResult, resultBindsAttempt } from "./verifier-result.js";
import type { Sha256 } from "./primitives.js";

const hex = "0123456789abcdef";
const D = (label: string): Sha256 => `sha256:${hex[label.charCodeAt(0) % 16]!.repeat(64)}` as Sha256;
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

const REF = "recallnet/thwip/.github/workflows/verify.yml@refs/heads/main";

function result(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    attemptId: "att-1",
    assignmentDigest: D("a"),
    integrationEvidenceKind: "integration-receipt",
    integrationEvidenceDigest: D("b"),
    policyDigest: D("c"),
    candidateSha: CANDIDATE,
    candidateTreeOid: TREE,
    verifierDigest: D("d"),
    independentRun: { mode: "none" },
    independentRunDigest: null,
    verdict: "accepted",
    reasonCodes: ["PASS"],
    github: {
      repositoryId: "1315419165",
      workflowRunId: "556677",
      runAttempt: 1,
      workflowRef: REF,
      workflowSha: "5".repeat(40),
      jobWorkflowRef: REF,
      jobWorkflowSha: "5".repeat(40),
      oidcJti: "jti-1",
    },
    observedAt: "2026-07-29T12:05:00Z",
    nonce: "nonce-1",
    ...over,
  };
}

function independentRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "github-actions",
    purpose: "remote-primary",
    candidateSha: CANDIDATE,
    candidateTreeOid: TREE,
    pipelineDigest: D("e"),
    daggerEngineDigest: D("f"),
    requiredSuitesDigest: D("1"),
    networkMode: "none",
    cacheMode: "disabled",
    suites: [{ name: "test", outcome: "passed", durationMs: 1200 }],
    startedAt: "2026-07-29T12:01:00Z",
    completedAt: "2026-07-29T12:04:00Z",
    ...over,
  };
}

describe("parseVerifierResult", () => {
  it("accepts a fresh result with no independent run", () => {
    expect(parseVerifierResult(result())).toMatchObject({ ok: true });
  });

  it("accepts a remote result whose independent run is the primary evidence", () => {
    const remote = result({
      integrationEvidenceKind: "independent-run",
      independentRun: independentRun(),
      independentRunDigest: D("2"),
    });
    expect(parseVerifierResult(remote)).toMatchObject({ ok: true });
  });

  it("accepts an audited result pairing a local receipt with a rerun", () => {
    const audited = result({
      integrationEvidenceKind: "integration-receipt",
      independentRun: independentRun({ purpose: "audited-rerun" }),
      independentRunDigest: D("2"),
    });
    expect(parseVerifierResult(audited)).toMatchObject({ ok: true });
  });

  it("accepts a rejected result with reason codes", () => {
    const rejected = result({ verdict: "rejected", reasonCodes: ["SUBJECT_TREE_MISMATCH"] });
    expect(parseVerifierResult(rejected)).toMatchObject({ ok: true });
  });

  describe("evidence kind and independent run must agree", () => {
    it("rejects an independent-run result with no run", () => {
      const wrong = result({ integrationEvidenceKind: "independent-run" });
      const parsed = parseVerifierResult(wrong);
      expect(parsed).toMatchObject({ ok: false });
      if (!parsed.ok) expect(parsed.detail).toMatch(/must carry an independent run/);
    });

    it("rejects an independent-run result whose purpose is a rerun", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun({ purpose: "audited-rerun" }),
        independentRunDigest: D("2"),
      });
      expect(parseVerifierResult(wrong)).toMatchObject({ ok: false });
    });

    it("rejects a local-evidence result carrying a remote-primary run", () => {
      const wrong = result({
        independentRun: independentRun({ purpose: "remote-primary" }),
        independentRunDigest: D("2"),
      });
      expect(parseVerifierResult(wrong)).toMatchObject({ ok: false });
    });

    it("requires a null digest when nothing ran independently", () => {
      expect(parseVerifierResult(result({ independentRunDigest: D("2") }))).toMatchObject({ ok: false });
    });

    it("requires a digest when something did run", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun(),
        independentRunDigest: null,
      });
      expect(parseVerifierResult(wrong)).toMatchObject({ ok: false });
    });

    it("rejects a none-mode run carrying run fields", () => {
      expect(
        parseVerifierResult(result({ independentRun: { mode: "none", suites: [] } })),
      ).toMatchObject({ ok: false });
    });
  });

  describe("the run must be of the candidate being verified", () => {
    it("rejects an independent run of a different candidate", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun({ candidateSha: "9".repeat(40) }),
        independentRunDigest: D("2"),
      });
      const parsed = parseVerifierResult(wrong);
      expect(parsed).toMatchObject({ ok: false });
      if (!parsed.ok) expect(parsed.detail).toMatch(/different candidate/);
    });

    it("rejects an independent run of a different tree", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun({ candidateTreeOid: "9".repeat(40) }),
        independentRunDigest: D("2"),
      });
      expect(parseVerifierResult(wrong)).toMatchObject({ ok: false });
    });
  });

  describe("verdict discipline", () => {
    it("refuses to accept a run with a failed suite", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun({
          suites: [
            { name: "lint", outcome: "passed", durationMs: 10 },
            { name: "test", outcome: "failed", durationMs: 20 },
          ],
        }),
        independentRunDigest: D("2"),
      });
      const parsed = parseVerifierResult(wrong);
      expect(parsed).toMatchObject({ ok: false });
      if (!parsed.ok) expect(parsed.detail).toMatch(/failed suite/);
    });

    it("requires a rejected result to say why", () => {
      expect(parseVerifierResult(result({ verdict: "rejected", reasonCodes: [] }))).toMatchObject({
        ok: false,
      });
    });

    it("refuses an accepted result carrying a failure code", () => {
      expect(
        parseVerifierResult(result({ verdict: "accepted", reasonCodes: ["SUITE_NOT_PASSED"] })),
      ).toMatchObject({ ok: false });
    });

    it("rejects a lowercase reason code", () => {
      expect(
        parseVerifierResult(result({ verdict: "rejected", reasonCodes: ["tree_mismatch"] })),
      ).toMatchObject({ ok: false });
    });

    it("rejects more than thirty-two reason codes", () => {
      expect(
        parseVerifierResult(
          result({
            verdict: "rejected",
            reasonCodes: Array.from({ length: 33 }, (_, i) => `CODE_${i}`),
          }),
        ),
      ).toMatchObject({ ok: false });
    });
  });

  describe("provenance", () => {
    it("requires a pinned workflow ref", () => {
      const loose = result({
        github: { ...(result()["github"] as Record<string, unknown>), workflowRef: "verify.yml" },
      });
      expect(parseVerifierResult(loose)).toMatchObject({ ok: false });
    });

    it("requires decimal GitHub ids", () => {
      const numeric = result({
        github: { ...(result()["github"] as Record<string, unknown>), workflowRunId: 556677 },
      });
      expect(parseVerifierResult(numeric)).toMatchObject({ ok: false });
    });

    it("rejects an unknown field", () => {
      expect(parseVerifierResult(result({ trustMe: true }))).toMatchObject({ ok: false });
    });

    it("rejects a run that completed before it started", () => {
      const wrong = result({
        integrationEvidenceKind: "independent-run",
        independentRun: independentRun({
          startedAt: "2026-07-29T12:04:00Z",
          completedAt: "2026-07-29T12:01:00Z",
        }),
        independentRunDigest: D("2"),
      });
      expect(parseVerifierResult(wrong)).toMatchObject({ ok: false });
    });
  });
});

describe("resultBindsAttempt", () => {
  const parsed = parseVerifierResult(result());
  const expected = {
    attemptId: "att-1",
    nonce: "nonce-1",
    assignmentDigest: D("a"),
    candidateSha: CANDIDATE,
    candidateTreeOid: TREE,
    policyDigest: D("c"),
    verifierDigest: D("d"),
    workflowRef: REF,
    workflowSha: "5".repeat(40),
  };

  it("binds a matching result", () => {
    expect(parsed.ok && resultBindsAttempt(parsed.value, expected)).toEqual({ bound: true });
  });

  it("rejects a well-formed result for another attempt", () => {
    expect(parsed.ok && resultBindsAttempt(parsed.value, { ...expected, attemptId: "att-2" })).toMatchObject({
      bound: false,
    });
  });

  it("rejects a replayed nonce", () => {
    expect(parsed.ok && resultBindsAttempt(parsed.value, { ...expected, nonce: "nonce-2" })).toMatchObject({
      bound: false,
    });
  });

  it("rejects a result from an unpinned workflow", () => {
    expect(
      parsed.ok && resultBindsAttempt(parsed.value, { ...expected, workflowSha: "8".repeat(40) }),
    ).toMatchObject({ bound: false });
  });
});
