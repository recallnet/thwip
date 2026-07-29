import { describe, expect, it } from "vitest";
import {
  acceptCallback,
  verifyVerifierIdentity,
  type CallbackLedger,
  type OidcVerifierClaims,
  type PinnedVerifier,
} from "./verifier-identity.js";

const pinned: PinnedVerifier = {
  repositoryId: "1315419165",
  repositoryOwnerId: "162603603",
  workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
  workflowSha: "5".repeat(40),
  reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify-impl.yml@refs/heads/main",
  reusableWorkflowSha: "6".repeat(40),
  expectedEventName: "repository_dispatch",
  defaultBranchRef: "refs/heads/main",
};

function claims(over: Partial<OidcVerifierClaims> = {}): OidcVerifierClaims {
  return {
    repository_id: "1315419165",
    repository_owner_id: "162603603",
    workflow_ref: pinned.workflowRef,
    workflow_sha: pinned.workflowSha,
    job_workflow_ref: pinned.reusableWorkflowRef,
    job_workflow_sha: pinned.reusableWorkflowSha,
    run_id: "998877",
    run_attempt: "1",
    event_name: "repository_dispatch",
    ref: "refs/heads/main",
    jti: "jti-1",
    ...over,
  };
}

describe("verifyVerifierIdentity", () => {
  it("accepts the pinned verifier", () => {
    expect(verifyVerifierIdentity(claims(), pinned)).toEqual({
      ok: true,
      runId: "998877",
      runAttempt: 1,
      jti: "jti-1",
    });
  });

  it("accepts a numeric repository id, since ids may arrive unquoted", () => {
    expect(verifyVerifierIdentity(claims({ repository_id: 1315419165 }), pinned)).toMatchObject({ ok: true });
  });

  describe("the workflow pin is the whole point", () => {
    it("refuses another workflow in the same repository", () => {
      // This is the attack the repository check alone does not stop: a
      // contributor adds a workflow, gets a valid token, and claims a verdict.
      const other = claims({
        workflow_ref: "recallnet/thwip/.github/workflows/i-added-this.yml@refs/heads/main",
      });
      const verdict = verifyVerifierIdentity(other, pinned);
      expect(verdict).toMatchObject({ ok: false });
      if (!verdict.ok) expect(verdict.reason).toMatch(/not the pinned verifier/);
    });

    it("refuses the right workflow path at a different commit", () => {
      expect(verifyVerifierIdentity(claims({ workflow_sha: "9".repeat(40) }), pinned)).toMatchObject({
        ok: false,
      });
    });

    it("refuses a job from an unpinned reusable workflow", () => {
      const swapped = claims({
        job_workflow_ref: "attacker/repo/.github/workflows/anything.yml@refs/heads/main",
      });
      const verdict = verifyVerifierIdentity(swapped, pinned);
      expect(verdict).toMatchObject({ ok: false });
      if (!verdict.ok) expect(verdict.reason).toMatch(/not the pinned reusable workflow/);
    });

    it("refuses a pinned reusable path at a different commit", () => {
      expect(verifyVerifierIdentity(claims({ job_workflow_sha: "9".repeat(40) }), pinned)).toMatchObject({
        ok: false,
      });
    });
  });

  it("refuses a run that did not come from a queue dispatch", () => {
    for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"]) {
      expect(verifyVerifierIdentity(claims({ event_name: event }), pinned)).toMatchObject({ ok: false });
    }
  });

  it("refuses a run from any ref but the default branch", () => {
    // A run on a pull request ref would execute contributor-controlled config.
    expect(verifyVerifierIdentity(claims({ ref: "refs/pull/42/merge" }), pinned)).toMatchObject({ ok: false });
    expect(verifyVerifierIdentity(claims({ ref: "refs/heads/feature" }), pinned)).toMatchObject({ ok: false });
  });

  it("refuses another repository or owner", () => {
    expect(verifyVerifierIdentity(claims({ repository_id: "999" }), pinned)).toMatchObject({ ok: false });
    expect(verifyVerifierIdentity(claims({ repository_owner_id: "999" }), pinned)).toMatchObject({ ok: false });
  });

  it("refuses a token missing any claim it depends on", () => {
    for (const key of [
      "repository_id",
      "repository_owner_id",
      "workflow_ref",
      "workflow_sha",
      "job_workflow_ref",
      "job_workflow_sha",
      "run_id",
      "run_attempt",
      "jti",
    ] as const) {
      const partial = claims();
      delete (partial as Record<string, unknown>)[key];
      expect(verifyVerifierIdentity(partial, pinned)).toMatchObject({ ok: false });
    }
  });

  it("refuses a non-decimal id rather than coercing it", () => {
    expect(verifyVerifierIdentity(claims({ repository_id: "13154e5" }), pinned)).toMatchObject({ ok: false });
    expect(verifyVerifierIdentity(claims({ run_id: -1 }), pinned)).toMatchObject({ ok: false });
  });
});

describe("acceptCallback", () => {
  function ledger(): CallbackLedger & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    return {
      entries,
      seen: (jti) => entries.has(jti),
      remember: (jti, attemptId) => void entries.set(jti, attemptId),
    };
  }

  const expected = { attemptId: "att-1", nonce: "nonce-1" };

  it("accepts one matching callback", () => {
    expect(
      acceptCallback({ ledger: ledger(), jti: "j1", attemptId: "att-1", nonce: "nonce-1", expected }),
    ).toEqual({ accepted: true });
  });

  it("refuses the same token twice, even for the same attempt", () => {
    const l = ledger();
    acceptCallback({ ledger: l, jti: "j1", attemptId: "att-1", nonce: "nonce-1", expected });
    expect(
      acceptCallback({ ledger: l, jti: "j1", attemptId: "att-1", nonce: "nonce-1", expected }),
    ).toMatchObject({ accepted: false, code: "REPLAYED_TOKEN" });
  });

  it("refuses a mismatched nonce", () => {
    expect(
      acceptCallback({ ledger: ledger(), jti: "j1", attemptId: "att-1", nonce: "other", expected }),
    ).toMatchObject({ accepted: false, code: "NONCE_MISMATCH" });
  });

  it("refuses a result for an attempt nobody is awaiting", () => {
    expect(
      acceptCallback({ ledger: ledger(), jti: "j1", attemptId: "att-9", nonce: "nonce-1", expected }),
    ).toMatchObject({ accepted: false, code: "STALE_ATTEMPT" });
    expect(
      acceptCallback({ ledger: ledger(), jti: "j1", attemptId: "att-1", nonce: "nonce-1", expected: null }),
    ).toMatchObject({ accepted: false, code: "STALE_ATTEMPT" });
  });

  it("does not record a rejected token, so a later valid use is still possible", () => {
    const l = ledger();
    acceptCallback({ ledger: l, jti: "j1", attemptId: "att-9", nonce: "nonce-1", expected });
    expect(l.entries.size).toBe(0);
  });
});
