import { describe, expect, it } from "vitest";
import { OVERRIDE_OMISSIONS } from "./merge-intent.js";
import { parseTransitionRecord } from "./transition-record.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const PREV_BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

function baseFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 0,
    transitionSequence: 2,
    previousTransitionDigest: D("f"),
    before: { baseSha: PREV_BASE, treeOid: "9".repeat(40) },
    after: {
      baseSha: CANDIDATE,
      treeOid: TREE,
      parentOids: [PREV_BASE, HEAD],
      parentCount: 2,
      parentOidsDigest: D("e"),
      parentsComplete: true,
    },
    observedAt: "2026-07-29T12:00:00Z",
    ...over,
  };
}

function verifiedMerge(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseFields(),
    kind: "verified-merge",
    verifiedMerge: {
      attemptId: "att-1",
      mergeIntentDigest: D("1"),
      pullRequestNumber: 42,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      assignmentDigest: D("3"),
      integrationEvidenceDigest: D("4"),
      verifierResultDigest: D("5"),
      checkRunId: "778899",
      actionRunId: "112233",
    },
    ...over,
  };
}

function overrideMerge(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseFields(),
    kind: "override-merge",
    override: {
      attemptId: "att-1",
      mergeIntentDigest: D("1"),
      pullRequestNumber: 42,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      assignmentDigest: D("3"),
      liveGuardDigest: D("6"),
      candidateCheckRunId: "778899",
      authorization: {
        actorGithubId: "264261678",
        reason: "verifier outage during a release freeze",
        omission: { profile: "fresh", omittedControls: OVERRIDE_OMISSIONS.fresh },
      },
    },
    ...over,
  };
}

describe("parseTransitionRecord", () => {
  it("accepts a verified merge", () => {
    expect(parseTransitionRecord(verifiedMerge())).toMatchObject({ ok: true });
  });

  it("accepts an override merge", () => {
    expect(parseTransitionRecord(overrideMerge())).toMatchObject({ ok: true });
  });

  it("accepts an external transition with only its reason code", () => {
    const external = {
      ...baseFields(),
      kind: "external-transition",
      external: { observationReasonCode: "unexpected_push" },
    };
    expect(parseTransitionRecord(external)).toMatchObject({ ok: true });
  });

  it("accepts a genesis that opens the first epoch", () => {
    const genesis = {
      ...baseFields({
        transitionSequence: 1,
        previousTransitionDigest: null,
        before: { baseSha: null, treeOid: null },
      }),
      kind: "genesis",
      genesis: {
        policyDigest: D("a"),
        configDigest: D("b"),
        rulesetDigest: D("c"),
        priorEpochClosingDigest: null,
      },
    };
    expect(parseTransitionRecord(genesis)).toMatchObject({ ok: true });
  });

  describe("kinds cannot be confused", () => {
    it("rejects a verified merge carrying an override block", () => {
      const both = verifiedMerge({ override: { actorGithubId: "1" } });
      const result = parseTransitionRecord(both);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/unexpected field override/);
    });

    it("rejects an override merge that fabricates a verifier digest", () => {
      const faked = overrideMerge({
        override: {
          ...(overrideMerge()["override"] as Record<string, unknown>),
          verifierResultDigest: D("9"),
        },
      });
      expect(parseTransitionRecord(faked)).toMatchObject({ ok: false });
    });

    it("rejects a record whose facts block does not match its kind", () => {
      const mismatched = { ...baseFields(), kind: "genesis", verifiedMerge: {} };
      expect(parseTransitionRecord(mismatched)).toMatchObject({ ok: false });
    });

    it("rejects an unknown kind", () => {
      expect(parseTransitionRecord(verifiedMerge({ kind: "rollback" }))).toMatchObject({ ok: false });
    });

    it("rejects an unknown external observation code", () => {
      const external = {
        ...baseFields(),
        kind: "external-transition",
        external: { observationReasonCode: "someone_did_something" },
      };
      expect(parseTransitionRecord(external)).toMatchObject({ ok: false });
    });
  });

  describe("the record must describe the commit that landed", () => {
    it("rejects a merge whose new base is not the candidate", () => {
      const wrong = verifiedMerge({
        after: { ...(baseFields()["after"] as Record<string, unknown>), baseSha: "8".repeat(40) },
      });
      const result = parseTransitionRecord(wrong);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/merged base must be the candidate/);
    });

    it("rejects a merge whose tree is not the candidate tree", () => {
      const wrong = verifiedMerge({
        after: { ...(baseFields()["after"] as Record<string, unknown>), treeOid: "8".repeat(40) },
      });
      const result = parseTransitionRecord(wrong);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/merged tree must be the candidate tree/);
    });

    it("rejects a merge whose first parent is not the previous base", () => {
      const wrong = verifiedMerge({
        after: {
          ...(baseFields()["after"] as Record<string, unknown>),
          parentOids: [HEAD, PREV_BASE],
        },
      });
      expect(parseTransitionRecord(wrong)).toMatchObject({ ok: false });
    });

    it("rejects a squash recorded with two parents", () => {
      const wrong = verifiedMerge({
        verifiedMerge: {
          ...(verifiedMerge()["verifiedMerge"] as Record<string, unknown>),
          mergeMethod: "squash",
        },
      });
      expect(parseTransitionRecord(wrong)).toMatchObject({ ok: false });
    });

    it("refuses an incomplete parent vector for a queue merge", () => {
      const wrong = verifiedMerge({
        after: {
          baseSha: CANDIDATE,
          treeOid: TREE,
          parentOids: Array.from({ length: 16 }, (_, i) => String(i % 10).repeat(40)),
          parentCount: 20,
          parentOidsDigest: D("e"),
          parentsComplete: false,
        },
      });
      const result = parseTransitionRecord(wrong);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/complete parent vector/);
    });

    it("allows an external octopus commit to embed only the first sixteen parents", () => {
      const external = {
        ...baseFields({
          after: {
            baseSha: CANDIDATE,
            treeOid: TREE,
            parentOids: Array.from({ length: 16 }, (_, i) => String(i % 10).repeat(40)),
            parentCount: 20,
            parentOidsDigest: D("e"),
            parentsComplete: false,
          },
        }),
        kind: "external-transition",
        external: { observationReasonCode: "imported_history" },
      };
      expect(parseTransitionRecord(external)).toMatchObject({ ok: true });
    });

    it("rejects parentsComplete false when the vector would have fit", () => {
      const external = {
        ...baseFields({
          after: {
            baseSha: CANDIDATE,
            treeOid: TREE,
            parentOids: [PREV_BASE, HEAD],
            parentCount: 2,
            parentOidsDigest: D("e"),
            parentsComplete: false,
          },
        }),
        kind: "external-transition",
        external: { observationReasonCode: "unexpected_push" },
      };
      expect(parseTransitionRecord(external)).toMatchObject({ ok: false });
    });

    it("rejects more than sixteen embedded parents", () => {
      const external = {
        ...baseFields({
          after: {
            baseSha: CANDIDATE,
            treeOid: TREE,
            parentOids: Array.from({ length: 17 }, (_, i) => String(i % 10).repeat(40)),
            parentCount: 17,
            parentOidsDigest: D("e"),
            parentsComplete: true,
          },
        }),
        kind: "external-transition",
        external: { observationReasonCode: "imported_history" },
      };
      expect(parseTransitionRecord(external)).toMatchObject({ ok: false });
    });
  });

  describe("chain shape", () => {
    it("requires the first transition to be the only one without a prior digest", () => {
      expect(
        parseTransitionRecord(verifiedMerge({ transitionSequence: 1, previousTransitionDigest: D("f") })),
      ).toMatchObject({ ok: false });
      expect(parseTransitionRecord(verifiedMerge({ previousTransitionDigest: null }))).toMatchObject({
        ok: false,
      });
    });

    it("rejects a transition that does not move the base", () => {
      const stationary = verifiedMerge({
        before: { baseSha: CANDIDATE, treeOid: TREE },
      });
      const result = parseTransitionRecord(stationary);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.detail).toMatch(/must move the base/);
    });

    it("rejects a null before state after the first transition", () => {
      expect(
        parseTransitionRecord(verifiedMerge({ before: { baseSha: null, treeOid: null } })),
      ).toMatchObject({ ok: false });
    });

    it("rejects a genesis that does not open an epoch", () => {
      const late = {
        ...baseFields(),
        kind: "genesis",
        genesis: {
          policyDigest: D("a"),
          configDigest: D("b"),
          rulesetDigest: D("c"),
          priorEpochClosingDigest: null,
        },
      };
      expect(parseTransitionRecord(late)).toMatchObject({ ok: false });
    });

    it("requires a later epoch's genesis to name the prior epoch's closing digest", () => {
      const orphan = {
        ...baseFields({
          queueEpoch: 3,
          transitionSequence: 1,
          previousTransitionDigest: null,
          before: { baseSha: null, treeOid: null },
        }),
        kind: "genesis",
        genesis: {
          policyDigest: D("a"),
          configDigest: D("b"),
          rulesetDigest: D("c"),
          priorEpochClosingDigest: null,
        },
      };
      expect(parseTransitionRecord(orphan)).toMatchObject({ ok: false });
    });

    it("rejects a parent count smaller than the embedded parents", () => {
      const wrong = verifiedMerge({
        after: {
          baseSha: CANDIDATE,
          treeOid: TREE,
          parentOids: [PREV_BASE, HEAD],
          parentCount: 1,
          parentOidsDigest: D("e"),
          parentsComplete: true,
        },
      });
      expect(parseTransitionRecord(wrong)).toMatchObject({ ok: false });
    });
  });

  it("rejects an oversize override reason before it can be signed", () => {
    const long = overrideMerge({
      override: {
        ...(overrideMerge()["override"] as Record<string, unknown>),
        authorization: {
          actorGithubId: "264261678",
          reason: "x".repeat(513),
          omission: { profile: "fresh", omittedControls: OVERRIDE_OMISSIONS.fresh },
        },
      },
    });
    expect(parseTransitionRecord(long)).toMatchObject({ ok: false });
  });
});

/**
 * A merge under a profile that asks for nothing beyond the proof already on the
 * head. It is its own kind rather than a verified merge with a field left out,
 * because a verified merge claims something ran against the integrated candidate
 * and here nothing did. A reader auditing the chain afterwards has no other way
 * to tell those two apart.
 */
describe("reused-proof-merge", () => {
  const reused = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...baseFields(),
    kind: "reused-proof-merge",
    reusedProof: {
      attemptId: "att-1",
      mergeIntentDigest: D("1"),
      pullRequestNumber: 42,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      assignmentDigest: D("3"),
      policyDigest: D("6"),
      pipelineDigest: D("7"),
      requiredSuitesDigest: D("8"),
      checkRunId: "778899",
      ...((over["reusedProof"] as Record<string, unknown>) ?? {}),
    },
  });

  it("accepts a merge that reused the head's proof", () => {
    expect(parseTransitionRecord(reused())).toMatchObject({ ok: true });
  });

  it("binds what makes the reuse legitimate", () => {
    const parsed = parseTransitionRecord(reused());
    if (!parsed.ok) throw new Error(parsed.detail);
    if (parsed.value.kind !== "reused-proof-merge") throw new Error("wrong kind");
    expect(parsed.value.reusedProof.policyDigest).toBe(D("6"));
    expect(parsed.value.reusedProof.pipelineDigest).toBe(D("7"));
    expect(parsed.value.reusedProof.requiredSuitesDigest).toBe(D("8"));
    expect(parsed.value.reusedProof.workReceiptDigest).toBe(D("2"));
  });

  /**
   * The point of the kind. Claiming a verifier result on a merge where no
   * verifier ran is the falsehood this exists to make unrepresentable, so the
   * schema refuses the field rather than ignoring it.
   */
  it("refuses to carry a verifier result, because none was produced", () => {
    const lying = reused();
    (lying["reusedProof"] as Record<string, unknown>)["verifierResultDigest"] = D("5");
    expect(parseTransitionRecord(lying)).toMatchObject({ ok: false });
  });

  it("refuses to carry integration evidence either", () => {
    const lying = reused();
    (lying["reusedProof"] as Record<string, unknown>)["integrationEvidenceDigest"] = D("4");
    expect(parseTransitionRecord(lying)).toMatchObject({ ok: false });
  });

  it("still requires everything a merge record has to say", () => {
    for (const missing of ["attemptId", "workReceiptDigest", "assignmentDigest", "policyDigest"]) {
      const short = reused();
      delete (short["reusedProof"] as Record<string, unknown>)[missing];
      expect(parseTransitionRecord(short), missing).toMatchObject({ ok: false });
    }
  });

  it("refuses a digest that is not one", () => {
    const bad = reused({ reusedProof: { pipelineDigest: "not-a-digest" } });
    expect(parseTransitionRecord(bad)).toMatchObject({ ok: false });
  });

  it("holds the same after/candidate consistency a verified merge does", () => {
    const inconsistent = reused({ reusedProof: { candidateSha: "9".repeat(40) } });
    expect(parseTransitionRecord(inconsistent)).toMatchObject({ ok: false });
  });
});
