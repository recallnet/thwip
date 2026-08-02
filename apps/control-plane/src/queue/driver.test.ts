import { describe, expect, it } from "vitest";
import { runTurn, type ProviderPort, type QueuePort, type TurnContext } from "./driver.js";
import type { Signer } from "./evidence.js";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import type { GuardObservation } from "./turn.js";

/**
 * The whole turn, driven with fakes. This is where the failure paths get
 * exercised: an ambiguous merge, a moved head, a landed tree that is not the
 * verified one, a re-entry after a crash, and observe mode declining to write.
 */

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);
const MERGE = "5".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;

const git: GitSubject = {
  objectFormat: "sha1",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
  baseSha: BASE,
  headRepositoryId: "1315419165",
  headSha: HEAD,
  candidateSha: CANDIDATE,
  candidateTreeOid: TREE,
  candidateParentOids: [BASE, HEAD],
};

function context(over: Partial<TurnContext> = {}): TurnContext {
  return {
    attemptId: "att-1",
    entryId: "entry-1",
    pullRequestNumber: 42,
    sponsorPrincipalId: "alice",
    ownerId: "162603603",
    activationState: "enforced",
    mergeMethod: "merge",
    queueEpoch: 0,
    turnSequence: 3,
    transitionSequence: 1,
    previousTransitionDigest: null,
    previousBase: { baseSha: null, treeOid: null },
    queueDecisionDigest: D("b"),
    workReceiptDigest: D("e"),
    pipelineDigest: D("f"),
    policy: {
      version: 4,
      securityProfile: "fresh",
      runner: "dagger",
      daggerModuleDigest: D("c"),
      daggerEngineDigest: D("d"),
      requiredSuites: ["lint", "test"],
      document: { profile: "fresh" },
    },
    // A local `run` assignment pins no GitHub workflow, so it carries no verifier.
    execution: { mode: "run", profile: "fresh", runnerPrincipalId: "alice", deviceKeyId: "key-1" },
    now: "2026-07-29T12:00:00Z",
    executionSeconds: 20 * 60,
    nonceSeed: "nonce-1",
    ...over,
  };
}

const signer: Signer = { async sign(bytes) { return `jws.${bytes.byteLength}`; } };

function guardFacts(over: Partial<GuardObservation> = {}): GuardObservation {
  return {
    baseSha: BASE,
    headSha: HEAD,
    candidateTreeOid: TREE,
    policyDigest: "",
    attemptRevision: 7,
    pullRequestOpen: true,
    reviewsSatisfied: true,
    signerStillAuthorized: true,
    rulesetEnforced: true,
    appPermissionsHealthy: true,
    queuePaused: false,
    ...over,
  };
}

function fakeQueue(over: Partial<QueuePort> = {}) {
  const calls: string[] = [];
  const record = (name: string) => {
    calls.push(name);
    return Promise.resolve({ status: "applied" });
  };
  const port: QueuePort = {
    candidatePrepared: () => record("candidatePrepared"),
    assign: () => record("assign"),
    startVerification: async () => {
      calls.push("startVerification");
      return { status: "applied", nonce: "issued-nonce" };
    },
    createMergeIntent: () => record("createMergeIntent"),
    beginMergeWrite: async () => {
      calls.push("beginMergeWrite");
      return { status: "applied" };
    },
    confirmMerge: () => record("confirmMerge"),
    confirmNotMerged: () => record("confirmNotMerged"),
    mergeOutcomeUnknown: () => record("mergeOutcomeUnknown"),
    recordTransition: () => record("recordTransition"),
    terminateAttempt: () => record("terminateAttempt"),
    pause: () => record("pause"),
    attemptRevision: async () => 7,
    ...over,
  };
  return { port, calls };
}

function fakeProvider(over: Partial<ProviderPort> = {}) {
  const calls: string[] = [];
  const base: ProviderPort = {
    resolveCandidate: async () => ({ status: "pinned", subject: git }),
    dispatchVerifier: async () => {},
    awaitVerifierResult: async () => ({
      accepted: true,
      resultDigest: D("1"),
      integrationEvidenceDigest: D("2"),
      checkRunId: "8899",
      actionRunId: "7788",
    }),
    readGuardFacts: async () => guardFacts(),
    merge: async () => ({
      status: 200,
      body: { merged: true, sha: MERGE, treeOid: TREE, parents: [BASE, HEAD] },
    }),
    observeResult: async () => ({
      merged: true,
      commit: { sha: MERGE, treeOid: TREE, parentShas: [BASE, HEAD] },
    }),
    baseContainsHead: async () => true,
    publishCheck: async () => {},
  };

  // Record every call *around* the override, so a test that replaces a method
  // still proves how many times the driver invoked it. Recording inside the
  // defaults would make an overridden method invisible, which silently weakens
  // any assertion about call counts.
  const merged = { ...base, ...over } as ProviderPort;
  const port = Object.fromEntries(
    (Object.keys(base) as Array<keyof ProviderPort>).map((name) => [
      name,
      async (input: never) => {
        calls.push(name);
        return (merged[name] as (arg: never) => unknown)(input);
      },
    ]),
  ) as unknown as ProviderPort;

  return { port, calls };
}

describe("runTurn", () => {
  it("merges and records a transition on the happy path", async () => {
    const queue = fakeQueue();
    // The driver computes the policy digest itself, so the guard has to be told
    // what it is. Read it from the assign call instead of guessing.
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context(), patched, provider.port, signer);
    expect(result).toMatchObject({ outcome: "merged", mergeSha: MERGE });
    expect(queue.calls).toContain("confirmMerge");
    expect(queue.calls).toContain("recordTransition");
    expect(provider.calls).toContain("merge");
    expect(provider.calls.at(-1)).toBe("publishCheck");
  });

  it("stops before writing in observe mode, having published what it would do", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({ readGuardFacts: async () => guardFacts({ policyDigest }) });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context({ activationState: "observe" }), patched, provider.port, signer);
    expect(result).toMatchObject({ outcome: "abandoned" });
    expect(result.outcome === "abandoned" && result.reason).toMatch(/observing: would have merged/);
    // The two things that must not have happened.
    expect(provider.calls).not.toContain("merge");
    expect(queue.calls).not.toContain("beginMergeWrite");
    // And the one that must.
    expect(provider.calls).toContain("publishCheck");
  });

  it("abandons a candidate that cannot be pinned", async () => {
    const queue = fakeQueue();
    const provider = fakeProvider({
      resolveCandidate: async () => ({ status: "blocked", reason: "MERGE_CONFLICT" }),
    });
    const result = await runTurn(context(), queue.port, provider.port, signer);
    expect(result).toMatchObject({ outcome: "abandoned", reason: "MERGE_CONFLICT" });
    expect(queue.calls).toEqual(["terminateAttempt"]);
    expect(provider.calls).not.toContain("merge");
  });

  it("does not merge when the verifier rejects", async () => {
    const queue = fakeQueue();
    const provider = fakeProvider({
      awaitVerifierResult: async () => ({ accepted: false, reason: "SUBJECT_TREE_MISMATCH" }),
    });
    const result = await runTurn(context(), queue.port, provider.port, signer);
    expect(result).toMatchObject({ outcome: "not-merged", reason: "SUBJECT_TREE_MISMATCH" });
    expect(provider.calls).not.toContain("merge");
    expect(queue.calls).toContain("terminateAttempt");
  });

  describe("the final guard blocks the write", () => {
    const cases: Array<[Partial<GuardObservation>, string]> = [
      [{ headSha: "9".repeat(40) }, "HEAD_MOVED"],
      [{ baseSha: "9".repeat(40) }, "BASE_MOVED"],
      [{ candidateTreeOid: "9".repeat(40) }, "SUBJECT_TREE_MISMATCH"],
      [{ pullRequestOpen: false }, "PR_CLOSED"],
      [{ reviewsSatisfied: false }, "REVIEWS_CHANGED"],
      [{ signerStillAuthorized: false }, "PERMISSION_REVOKED"],
      [{ rulesetEnforced: false }, "RULESET_DRIFT"],
      [{ queuePaused: true }, "QUEUE_PAUSED"],
      [{ attemptRevision: 8 }, "ATTEMPT_REVISION_CHANGED"],
    ];

    for (const [change, reason] of cases) {
      it(`refuses to merge on ${reason}`, async () => {
        const queue = fakeQueue();
        let policyDigest = "";
        const provider = fakeProvider({
          readGuardFacts: async () => guardFacts({ policyDigest, ...change }),
        });
        const patched: QueuePort = {
          ...queue.port,
          candidatePrepared: async (input) => {
            policyDigest = input.policyDigest;
            return queue.port.candidatePrepared(input);
          },
        };
        const result = await runTurn(context(), patched, provider.port, signer);
        expect(result).toMatchObject({ outcome: "not-merged", reason });
        expect(provider.calls).not.toContain("merge");
      });
    }
  });

  it("reconciles rather than retrying when the merge outcome is unknown", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async () => ({ status: 0, transportError: "ECONNRESET" }),
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };
    const result = await runTurn(context(), patched, provider.port, signer);
    expect(result).toMatchObject({ outcome: "reconciling" });
    expect(queue.calls).toContain("mergeOutcomeUnknown");
    expect(queue.calls).not.toContain("confirmMerge");
    expect(provider.calls.filter((c) => c === "merge")).toHaveLength(1);
  });

  it("reads instead of writing when re-entering after a crash", async () => {
    const queue = fakeQueue({
      beginMergeWrite: async () => ({ status: "already-started", outcome: null }),
    });
    let policyDigest = "";
    const provider = fakeProvider({ readGuardFacts: async () => guardFacts({ policyDigest }) });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };
    const result = await runTurn(context(), patched, provider.port, signer);
    expect(result).toMatchObject({ outcome: "merged" });
    // The whole point: it observed instead of sending a second PUT.
    expect(provider.calls).not.toContain("merge");
    expect(provider.calls).toContain("observeResult");
  });

  it("raises an incident when the landed tree is not the verified tree", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async () => ({
        status: 200,
        body: { merged: true, sha: MERGE, treeOid: "9".repeat(40), parents: [BASE, HEAD] },
      }),
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };
    const result = await runTurn(context(), patched, provider.port, signer);
    expect(result).toMatchObject({ outcome: "incident" });
    expect(queue.calls).toContain("pause");
    expect(queue.calls).not.toContain("confirmMerge");
  });

  /**
   * Pull request 105 merged at 16:41:38 and the queue recorded
   * CONFIRMED_NOT_MERGED at 16:41:39, because GitHub's read had not caught up
   * with GitHub's own write. No transition record was written for a merge that
   * is on main, so the chain stopped one link short of the truth.
   */
  it("does not conclude a merge is absent while GitHub's read is behind its own write", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    let observations = 0;
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      // A racing merge run landed it; ours is told it may not merge.
      merge: async () => ({ status: 405, body: { message: "Merge already in progress" } }),
      observeResult: async () => {
        observations += 1;
        return observations === 1
          ? { merged: false, commit: null }
          : { merged: true, commit: { sha: MERGE, treeOid: TREE, parentShas: [BASE, HEAD] } };
      },
      baseContainsHead: async () => false,
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });
    expect(queue.calls).not.toContain("confirmNotMerged");
    expect(result).toMatchObject({ outcome: "merged", mergeSha: MERGE });
    expect(queue.calls).toContain("recordTransition");
  });

  it("believes git over the pull request when the base already contains the head", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async () => ({ status: 405, body: { message: "Merge already in progress" } }),
      // Every pull request read is behind; git is not.
      observeResult: async () => ({ merged: false, commit: null }),
      baseContainsHead: async () => true,
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });
    expect(queue.calls).not.toContain("confirmNotMerged");
    expect(queue.calls).toContain("mergeOutcomeUnknown");
    expect(result).toMatchObject({ outcome: "reconciling" });
  });

  it("does not conclude a merge is absent when GitHub cannot be read at all", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async () => ({ status: 409, body: { message: "Head branch was modified" } }),
      observeResult: async () => ({ merged: false, commit: null }),
      baseContainsHead: async () => null,
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });
    expect(queue.calls).not.toContain("confirmNotMerged");
    expect(result).toMatchObject({ outcome: "reconciling" });
  });

  it("treats a refusal every read confirms as a clean non-merge", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async () => ({ status: 409, body: { message: "Head branch was modified" } }),
      observeResult: async () => ({ merged: false, commit: null }),
      baseContainsHead: async () => false,
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };
    const result = await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });
    expect(result).toMatchObject({ outcome: "not-merged" });
    expect(queue.calls).toContain("confirmNotMerged");
  });

  it("never sends more than one merge request in any path", async () => {
    const responses = [
      { status: 200, body: { merged: true, sha: MERGE, treeOid: TREE, parents: [BASE, HEAD] } },
      { status: 409, body: { message: "moved" } },
      { status: 500 },
      { status: 0, transportError: "reset" },
      { status: 422 },
    ];
    for (const response of responses) {
      const queue = fakeQueue();
      let policyDigest = "";
      const provider = fakeProvider({
        readGuardFacts: async () => guardFacts({ policyDigest }),
        merge: async () => {
          return response as never;
        },
      });
      const patched: QueuePort = {
        ...queue.port,
        candidatePrepared: async (input) => {
          policyDigest = input.policyDigest;
          return queue.port.candidatePrepared(input);
        },
      };
      await runTurn(context(), patched, provider.port, signer);
      expect(provider.calls.filter((c) => c === "merge").length, JSON.stringify(response)).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The base the turn merges onto.
 *
 * The intent pins a base, a head and the tree the merge will produce, and that
 * tree is what the candidate was verified against. GitHub's
 * merge-pull-request API takes an expected head and no expected base, so a port
 * handed only the head merges onto whatever the branch is at that instant. Pull
 * requests 114, 117 and 119 did exactly that, three times, and GitHub reported
 * every one of them as a success.
 */
describe("the base a turn merges onto", () => {
  it("hands the port the base and the tree it verified, not only the head", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    let asked: Record<string, unknown> | null = null;
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      merge: async (input) => {
        asked = input as unknown as Record<string, unknown>;
        return { status: 200, body: { merged: true, sha: MERGE, treeOid: TREE, parents: [BASE, HEAD] } };
      },
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });

    expect(asked).toMatchObject({
      expectedBaseSha: BASE,
      expectedHeadSha: HEAD,
      candidateTreeOid: TREE,
      mergeMethod: "merge",
    });
  });

  it("ends the turn when the base moved, rather than merging onto the new one", async () => {
    const queue = fakeQueue();
    let policyDigest = "";
    const provider = fakeProvider({
      readGuardFacts: async () => guardFacts({ policyDigest }),
      // What GitHub answers a ref update that would not fast-forward: the base
      // is no longer the commit this candidate was built on.
      merge: async () => ({ status: 422, body: { message: "Update is not a fast forward" } }),
      observeResult: async () => ({ merged: false, commit: null }),
      baseContainsHead: async () => false,
    });
    const patched: QueuePort = {
      ...queue.port,
      candidatePrepared: async (input) => {
        policyDigest = input.policyDigest;
        return queue.port.candidatePrepared(input);
      },
    };

    const result = await runTurn(context(), patched, provider.port, signer, { sleep: async () => {} });

    expect(result.outcome).toBe("not-merged");
    expect(result).toMatchObject({ reason: expect.stringContaining("BASE_MOVED") });
    // Nothing was recorded as merged and nothing asked for a second write.
    expect(queue.calls).toContain("confirmNotMerged");
    expect(queue.calls).not.toContain("confirmMerge");
    expect(queue.calls).not.toContain("recordTransition");
    expect(provider.calls.filter((call) => call === "merge")).toHaveLength(1);
  });
});
