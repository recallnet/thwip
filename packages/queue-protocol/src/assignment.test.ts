import { describe, expect, it } from "vitest";
import { assignmentWindow, parseIntegrationAssignment } from "./assignment.js";

/** Digests must be hex, so map a label to a stable hex fill. */
const D = (label: string) => {
  const hex = "0123456789abcdef";
  const c = hex[label.charCodeAt(0) % 16]!;
  return `sha256:${c.repeat(64)}`;
};
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

function assignment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    assignmentId: "asg-1",
    attemptId: "att-1",
    repository: { ownerId: "162603603", repositoryId: "1315419165", baseRef: "refs/heads/main" },
    queue: {
      queueEpoch: 0,
      turnSequence: 5,
      entryId: "entry-1",
      pullRequestNumber: 42,
      sponsorPrincipalId: "alice",
      queueDecisionDigest: D("d"),
    },
    execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: "key-1" },
    git: {
      objectFormat: "sha1",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      baseSha: BASE,
      headRepositoryId: "1315419165",
      headSha: HEAD,
      candidateSha: "3".repeat(40),
      candidateTreeOid: "4".repeat(40),
      candidateParentOids: [BASE, HEAD],
    },
    policy: {
      digest: D("p"),
      version: 4,
      securityProfile: "fresh",
      daggerModuleDigest: D("m"),
      daggerEngineDigest: D("e"),
      requiredSuites: ["lint", "typecheck", "test"],
    },
    evidence: { workReceiptDigest: D("w"), previousTransitionDigest: D("t") },
    verifier: {
      workflowRef: "recallnet/thwip/.github/workflows/verify.yml@refs/heads/main",
      workflowSha: "5".repeat(40),
      reusableWorkflowRef: "recallnet/thwip/.github/workflows/reusable.yml@refs/heads/main",
      reusableWorkflowSha: "6".repeat(40),
      verifierDigest: D("v"),
    },
    timing: {
      issuedAt: "2026-07-29T12:00:00Z",
      notBefore: "2026-07-29T12:00:00Z",
      expiresAt: "2026-07-29T12:20:00Z",
    },
    nonce: "nonce-1",
    ...over,
  };
}

describe("parseIntegrationAssignment", () => {
  it("accepts a well-formed fresh assignment", () => {
    expect(parseIntegrationAssignment(assignment())).toMatchObject({ ok: true });
  });

  it("accepts a fast reuse assignment", () => {
    const fast = assignment({
      policy: { ...(assignment()["policy"] as Record<string, unknown>), securityProfile: "fast" },
      execution: { mode: "reuse", originalReceiptDigest: D("r"), originalSignerKeyId: "key-9" },
    });
    expect(parseIntegrationAssignment(fast)).toMatchObject({ ok: true });
  });

  it("accepts a remote assignment", () => {
    const remote = assignment({
      policy: { ...(assignment()["policy"] as Record<string, unknown>), securityProfile: "remote" },
      execution: {
        mode: "remote",
        provider: "github-actions",
        workflowRef: "recallnet/thwip/.github/workflows/remote.yml@refs/heads/main",
        workflowSha: "7".repeat(40),
      },
    });
    expect(parseIntegrationAssignment(remote)).toMatchObject({ ok: true });
  });

  describe("execution mode must match the profile", () => {
    it("refuses reuse outside the fast profile", () => {
      const wrong = assignment({
        execution: { mode: "reuse", originalReceiptDigest: D("r"), originalSignerKeyId: "key-9" },
      });
      const result = parseIntegrationAssignment(wrong);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/only the fast profile may reuse/);
    });

    it("refuses provider execution outside the remote profile", () => {
      const wrong = assignment({
        execution: {
          mode: "remote",
          provider: "github-actions",
          workflowRef: "a/b/c.yml@refs/heads/main",
          workflowSha: "7".repeat(40),
        },
      });
      expect(parseIntegrationAssignment(wrong)).toMatchObject({ ok: false });
    });

    it("refuses a device run whose profile disagrees with the policy", () => {
      const wrong = assignment({
        execution: { mode: "run", profile: "audited", runnerPrincipalId: "alice", deviceKeyId: "key-1" },
      });
      expect(parseIntegrationAssignment(wrong)).toMatchObject({ ok: false });
    });

    it("refuses a device run under the fast profile, which has nothing to run", () => {
      const wrong = assignment({
        policy: { ...(assignment()["policy"] as Record<string, unknown>), securityProfile: "fast" },
      });
      expect(parseIntegrationAssignment(wrong)).toMatchObject({ ok: false });
    });

    it("rejects a field from another execution variant", () => {
      const mixed = assignment({
        execution: {
          mode: "run",
          profile: "fresh",
          runnerPrincipalId: "alice",
          deviceKeyId: "key-1",
          originalReceiptDigest: D("r"),
        },
      });
      expect(parseIntegrationAssignment(mixed)).toMatchObject({ ok: false });
    });
  });

  describe("the assignment pins one exact candidate", () => {
    it("rejects a git subject for a different repository", () => {
      const wrong = assignment({
        git: { ...(assignment()["git"] as Record<string, unknown>), repositoryId: "999" },
      });
      expect(parseIntegrationAssignment(wrong)).toMatchObject({ ok: false });
    });

    it("rejects a git subject for a different base ref", () => {
      const wrong = assignment({
        git: { ...(assignment()["git"] as Record<string, unknown>), baseRef: "refs/heads/release" },
      });
      expect(parseIntegrationAssignment(wrong)).toMatchObject({ ok: false });
    });
  });

  describe("timing", () => {
    it("rejects an execution window shorter than five minutes", () => {
      const tight = assignment({
        timing: {
          issuedAt: "2026-07-29T12:00:00Z",
          notBefore: "2026-07-29T12:00:00Z",
          expiresAt: "2026-07-29T12:02:00Z",
        },
      });
      expect(parseIntegrationAssignment(tight)).toMatchObject({ ok: false });
    });

    it("rejects an execution window longer than forty-five minutes", () => {
      const loose = assignment({
        timing: {
          issuedAt: "2026-07-29T12:00:00Z",
          notBefore: "2026-07-29T12:00:00Z",
          expiresAt: "2026-07-29T13:00:00Z",
        },
      });
      expect(parseIntegrationAssignment(loose)).toMatchObject({ ok: false });
    });

    it("rejects notBefore earlier than issuedAt", () => {
      const backwards = assignment({
        timing: {
          issuedAt: "2026-07-29T12:00:00Z",
          notBefore: "2026-07-29T11:00:00Z",
          expiresAt: "2026-07-29T12:20:00Z",
        },
      });
      expect(parseIntegrationAssignment(backwards)).toMatchObject({ ok: false });
    });
  });

  describe("policy", () => {
    it("requires at least one suite and no repeats", () => {
      const none = assignment({
        policy: { ...(assignment()["policy"] as Record<string, unknown>), requiredSuites: [] },
      });
      expect(parseIntegrationAssignment(none)).toMatchObject({ ok: false });
      const repeated = assignment({
        policy: {
          ...(assignment()["policy"] as Record<string, unknown>),
          requiredSuites: ["lint", "lint"],
        },
      });
      expect(parseIntegrationAssignment(repeated)).toMatchObject({ ok: false });
    });

    it("rejects more than thirty-two suites", () => {
      const many = assignment({
        policy: {
          ...(assignment()["policy"] as Record<string, unknown>),
          requiredSuites: Array.from({ length: 33 }, (_, i) => `suite-${i}`),
        },
      });
      expect(parseIntegrationAssignment(many)).toMatchObject({ ok: false });
    });
  });

  it("requires the verifier workflow to be a pinned path, not a bare name", () => {
    const loose = assignment({
      verifier: { ...(assignment()["verifier"] as Record<string, unknown>), workflowRef: "verify.yml" },
    });
    expect(parseIntegrationAssignment(loose)).toMatchObject({ ok: false });
  });

  it("rejects an unknown top-level field", () => {
    expect(parseIntegrationAssignment(assignment({ priority: 1 }))).toMatchObject({ ok: false });
  });
});

describe("assignmentWindow", () => {
  it("distinguishes too early from expired", () => {
    const parsed = parseIntegrationAssignment(assignment());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(assignmentWindow(parsed.value, "2026-07-29T11:59:59Z")).toEqual({
      usable: false,
      reason: "TOO_EARLY",
    });
    expect(assignmentWindow(parsed.value, "2026-07-29T12:10:00Z")).toEqual({ usable: true });
    expect(assignmentWindow(parsed.value, "2026-07-29T12:20:00Z")).toEqual({
      usable: false,
      reason: "EXPIRED",
    });
  });
});
