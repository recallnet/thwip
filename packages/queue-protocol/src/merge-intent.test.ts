import { describe, expect, it } from "vitest";
import { OVERRIDE_OMISSIONS, parseMergeIntent } from "./merge-intent.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

function git(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectFormat: "sha1",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    headRepositoryId: "1315419165",
    headSha: HEAD_SHA,
    candidateSha: "3".repeat(40),
    candidateTreeOid: "4".repeat(40),
    candidateParentOids: [BASE_SHA, HEAD_SHA],
    ...over,
  };
}

function verified(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    kind: "verified",
    operationId: "op-1",
    attemptId: "att-1",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 1,
    turnSequence: 4,
    transitionSequence: 9,
    git: git(),
    pullRequestNumber: 42,
    mergeMethod: "merge",
    policyDigest: D("a"),
    previousTransitionDigest: D("b"),
    generatedCommitTitle: "Merge pull request #42",
    generatedCommitMessageDigest: D("c"),
    createdAt: "2026-07-29T12:00:00Z",
    evidence: {
      workReceiptDigest: D("1"),
      assignmentDigest: D("2"),
      integrationEvidenceDigest: D("3"),
      pipelineDigest: D("6"),
      requiredSuitesDigest: D("7"),
      execution: { ranOn: "device", deviceKeyId: "dev-1" },
    },
    ...over,
  };
}

/** The same intent, with the audited profile's second execution named. */
function verifiedInActions(over: Record<string, unknown> = {}): Record<string, unknown> {
  const intent = verified();
  return {
    ...intent,
    evidence: {
      ...(intent["evidence"] as Record<string, unknown>),
      execution: {
        ranOn: "github-actions",
        verifierResultDigest: D("4"),
        checkRunId: "88991122",
        actionRunId: "112233",
      },
    },
    ...over,
  };
}

function override(profile: keyof typeof OVERRIDE_OMISSIONS = "fresh", over: Record<string, unknown> = {}) {
  const { evidence: _drop, ...rest } = verified();
  return {
    ...rest,
    kind: "override",
    evidence: {
      workReceiptDigest: D("1"),
      assignmentDigest: D("2"),
      liveGuardDigest: D("5"),
      candidateCheckRunId: "88991122",
    },
    override: {
      actorGithubId: "264261678",
      reason: "release blocker; verifier outage",
      omission: { profile, omittedControls: OVERRIDE_OMISSIONS[profile] },
    },
    ...over,
  };
}

/**
 * The intent for a merge that rests on the proof already carried by the head.
 *
 * It exists for the same reason the reused-proof transition record does: a
 * verified intent claims a verifier ran against the integrated candidate, and
 * under this profile none did. Signing a verified intent anyway would put that
 * claim under the queue's own signature.
 */
function reused(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { evidence: _drop, ...rest } = verified();
  return {
    ...rest,
    kind: "reused",
    evidence: {
      workReceiptDigest: D("1"),
      pipelineDigest: D("6"),
      requiredSuitesDigest: D("7"),
      proofCheckRunId: "88991122",
    },
    ...over,
  };
}

describe("parseMergeIntent", () => {
  it("accepts a well-formed verified intent", () => {
    expect(parseMergeIntent(verified())).toMatchObject({ ok: true });
  });

  /**
   * Under `fresh` the suites run on the developer's own machine. There is no
   * check run and no Actions run for that execution, so the intent says where
   * it ran and names the device rather than borrowing a GitHub id from some
   * other run and presenting it as the one that verified the candidate.
   */
  describe("where the integration ran", () => {
    it("binds the assignment, the receipt and the device that ran it", () => {
      const parsed = parseMergeIntent(verified());
      if (!parsed.ok) throw new Error(parsed.detail);
      if (parsed.value.kind !== "verified") throw new Error("wrong kind");
      expect(parsed.value.evidence.assignmentDigest).toBe(D("2"));
      expect(parsed.value.evidence.integrationEvidenceDigest).toBe(D("3"));
      expect(parsed.value.evidence.execution).toEqual({ ranOn: "device", deviceKeyId: "dev-1" });
    });

    it("accepts a second execution in Actions, with its result and its run ids", () => {
      const parsed = parseMergeIntent(verifiedInActions());
      if (!parsed.ok) throw new Error(parsed.detail);
      if (parsed.value.kind !== "verified") throw new Error("wrong kind");
      expect(parsed.value.evidence.execution).toEqual({
        ranOn: "github-actions",
        verifierResultDigest: D("4"),
        checkRunId: "88991122",
        actionRunId: "112233",
      });
    });

    it("refuses a device execution that names a check run", () => {
      const lying = verified({
        evidence: {
          workReceiptDigest: D("1"),
          assignmentDigest: D("2"),
          integrationEvidenceDigest: D("3"),
          pipelineDigest: D("6"),
          requiredSuitesDigest: D("7"),
          execution: { ranOn: "device", deviceKeyId: "dev-1", checkRunId: "88991122" },
        },
      });
      expect(parseMergeIntent(lying)).toMatchObject({ ok: false });
    });

    it("refuses an Actions execution missing the result it produced", () => {
      const partial = verified({
        evidence: {
          workReceiptDigest: D("1"),
          assignmentDigest: D("2"),
          integrationEvidenceDigest: D("3"),
          pipelineDigest: D("6"),
          requiredSuitesDigest: D("7"),
          execution: { ranOn: "github-actions", checkRunId: "88991122", actionRunId: "112233" },
        },
      });
      expect(parseMergeIntent(partial)).toMatchObject({ ok: false });
    });

    it("refuses an intent that does not say where the integration ran", () => {
      const silent = verified({
        evidence: {
          workReceiptDigest: D("1"),
          assignmentDigest: D("2"),
          integrationEvidenceDigest: D("3"),
          pipelineDigest: D("6"),
          requiredSuitesDigest: D("7"),
        },
      });
      expect(parseMergeIntent(silent)).toMatchObject({ ok: false });
    });
  });

  describe("a merge that reused the head's proof", () => {
    it("accepts a well-formed reused intent", () => {
      expect(parseMergeIntent(reused())).toMatchObject({ ok: true });
    });

    it("binds the proof and the equivalence the reuse rests on", () => {
      const parsed = parseMergeIntent(reused());
      if (!parsed.ok) throw new Error(parsed.detail);
      if (parsed.value.kind !== "reused") throw new Error("wrong kind");
      expect(parsed.value.evidence.workReceiptDigest).toBe(D("1"));
      expect(parsed.value.evidence.pipelineDigest).toBe(D("6"));
      expect(parsed.value.evidence.requiredSuitesDigest).toBe(D("7"));
      expect(parsed.value.evidence.proofCheckRunId).toBe("88991122");
    });

    it("refuses a verifier result, because nothing ran to produce one", () => {
      const lying = reused({
        evidence: {
          workReceiptDigest: D("1"),
          pipelineDigest: D("6"),
          requiredSuitesDigest: D("7"),
          proofCheckRunId: "88991122",
          verifierResultDigest: D("9"),
        },
      });
      expect(parseMergeIntent(lying)).toMatchObject({ ok: false });
    });

    /** Nothing was dispatched, so there is no assignment to name. */
    it("refuses an assignment, because nothing was assigned", () => {
      const lying = reused({
        evidence: {
          workReceiptDigest: D("1"),
          assignmentDigest: D("2"),
          pipelineDigest: D("6"),
          requiredSuitesDigest: D("7"),
          proofCheckRunId: "88991122",
        },
      });
      expect(parseMergeIntent(lying)).toMatchObject({ ok: false });
    });

    it("refuses an override authorization", () => {
      const smuggled = reused({
        override: { actorGithubId: "1", reason: "x", omission: { profile: "fast", omittedControls: [] } },
      });
      expect(parseMergeIntent(smuggled)).toMatchObject({ ok: false });
    });

    it("still holds the candidate to the thing being merged", () => {
      const inconsistent = reused({ git: git({ candidateSha: "9".repeat(40) }), mergeMethod: "merge" });
      const parsed = parseMergeIntent(inconsistent);
      // Whatever the base rules say about candidate consistency, the reused kind
      // is subject to them exactly as the verified kind is.
      expect(parsed.ok).toBe(parseMergeIntent(verified({ git: git({ candidateSha: "9".repeat(40) }) })).ok);
    });
  });

  it("accepts a well-formed override for every profile", () => {
    for (const profile of Object.keys(OVERRIDE_OMISSIONS) as Array<keyof typeof OVERRIDE_OMISSIONS>) {
      expect(parseMergeIntent(override(profile))).toMatchObject({ ok: true });
    }
  });

  describe("the two variants cannot be confused", () => {
    it("rejects a verified intent that carries an override authorization", () => {
      const smuggled = verified({
        override: { actorGithubId: "1", reason: "x", omission: { profile: "fast", omittedControls: [] } },
      });
      const result = parseMergeIntent(smuggled);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/unexpected field override/);
    });

    it("rejects an override that fabricates verifier evidence", () => {
      const faked = override("fresh", {
        evidence: {
          workReceiptDigest: D("1"),
          assignmentDigest: D("2"),
          liveGuardDigest: D("5"),
          candidateCheckRunId: "88991122",
          verifierResultDigest: D("9"),
        },
      });
      const result = parseMergeIntent(faked);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/unexpected field verifierResultDigest/);
    });

    it("rejects an override with no authorization at all", () => {
      const { override: _drop, ...bare } = override();
      expect(parseMergeIntent(bare)).toMatchObject({ ok: false });
    });

    it("rejects an unknown kind", () => {
      expect(parseMergeIntent(verified({ kind: "emergency" }))).toMatchObject({ ok: false });
    });
  });

  describe("the omission tuple is exact", () => {
    it("rejects an extra omitted control", () => {
      const widened = override("fresh", {
        override: {
          actorGithubId: "264261678",
          reason: "release blocker",
          omission: {
            profile: "fresh",
            omittedControls: [...OVERRIDE_OMISSIONS.fresh, "integration_receipt_signature"],
          },
        },
      });
      expect(parseMergeIntent(widened)).toMatchObject({ ok: false });
    });

    it("rejects a missing omitted control", () => {
      const narrowed = override("audited", {
        override: {
          actorGithubId: "264261678",
          reason: "release blocker",
          omission: { profile: "audited", omittedControls: OVERRIDE_OMISSIONS.audited.slice(0, 2) },
        },
      });
      expect(parseMergeIntent(narrowed)).toMatchObject({ ok: false });
    });

    it("rejects a reordered omitted control", () => {
      const reordered = override("fresh", {
        override: {
          actorGithubId: "264261678",
          reason: "release blocker",
          omission: { profile: "fresh", omittedControls: [...OVERRIDE_OMISSIONS.fresh].reverse() },
        },
      });
      expect(parseMergeIntent(reordered)).toMatchObject({ ok: false });
    });

    it("rejects another profile's tuple", () => {
      const mismatched = override("fresh", {
        override: {
          actorGithubId: "264261678",
          reason: "release blocker",
          omission: { profile: "fresh", omittedControls: OVERRIDE_OMISSIONS.remote },
        },
      });
      expect(parseMergeIntent(mismatched)).toMatchObject({ ok: false });
    });

    it("rejects a blank or oversize reason before signing", () => {
      expect(
        parseMergeIntent(
          override("fresh", {
            override: {
              actorGithubId: "264261678",
              reason: "   ",
              omission: { profile: "fresh", omittedControls: OVERRIDE_OMISSIONS.fresh },
            },
          }),
        ),
      ).toMatchObject({ ok: false });

      expect(
        parseMergeIntent(
          override("fresh", {
            override: {
              actorGithubId: "264261678",
              reason: "x".repeat(513),
              omission: { profile: "fresh", omittedControls: OVERRIDE_OMISSIONS.fresh },
            },
          }),
        ),
      ).toMatchObject({ ok: false });
    });
  });

  describe("the candidate must be the thing being merged", () => {
    it("rejects a candidate whose first parent is not the base", () => {
      const wrong = verified({ git: git({ candidateParentOids: [HEAD_SHA, BASE_SHA] }) });
      const result = parseMergeIntent(wrong);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/first candidate parent/);
    });

    it("requires two parents for a merge and one for a squash", () => {
      expect(
        parseMergeIntent(verified({ git: git({ candidateParentOids: [BASE_SHA] }) })),
      ).toMatchObject({ ok: false });
      expect(
        parseMergeIntent(
          verified({ mergeMethod: "squash", git: git({ candidateParentOids: [BASE_SHA] }) }),
        ),
      ).toMatchObject({ ok: true });
      expect(parseMergeIntent(verified({ mergeMethod: "squash" }))).toMatchObject({ ok: false });
    });

    it("rejects a repository or base ref that disagrees with the subject", () => {
      expect(parseMergeIntent(verified({ repositoryId: "999" }))).toMatchObject({ ok: false });
      expect(parseMergeIntent(verified({ baseRef: "refs/heads/release" }))).toMatchObject({ ok: false });
    });
  });

  describe("field discipline", () => {
    it("rejects a numeric GitHub id", () => {
      expect(parseMergeIntent(verified({ repositoryId: 1315419165 }))).toMatchObject({ ok: false });
    });

    it("rejects a zero or negative sequence", () => {
      expect(parseMergeIntent(verified({ turnSequence: 0 }))).toMatchObject({ ok: false });
      expect(parseMergeIntent(verified({ transitionSequence: -1 }))).toMatchObject({ ok: false });
    });

    it("accepts a null previous transition digest only", () => {
      expect(parseMergeIntent(verified({ previousTransitionDigest: null }))).toMatchObject({ ok: true });
      expect(parseMergeIntent(verified({ previousTransitionDigest: "" }))).toMatchObject({ ok: false });
    });

    it("rejects a multi-line or oversize commit title", () => {
      expect(parseMergeIntent(verified({ generatedCommitTitle: "a\nb" }))).toMatchObject({ ok: false });
      expect(parseMergeIntent(verified({ generatedCommitTitle: "x".repeat(513) }))).toMatchObject({
        ok: false,
      });
    });

    it("rejects an unknown top-level field", () => {
      expect(parseMergeIntent(verified({ jumpQueue: true }))).toMatchObject({ ok: false });
    });

    it("rejects a wrong schema version", () => {
      expect(parseMergeIntent(verified({ schemaVersion: "2" }))).toMatchObject({ ok: false });
    });
  });
});
