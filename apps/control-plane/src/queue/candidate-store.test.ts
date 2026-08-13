import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import {
  candidateVerdict,
  candidateDispatchBindingV2,
  claimCandidateDispatchV2,
  claimCandidateDispatchV3,
  claimPendingCandidateReports,
  finalizeCandidateVerdictV3,
  finishPendingCandidateReport,
  legacyVerifierProtocol,
  recordCandidateVerdictV2,
  registerCandidateReport,
  type CandidateDispatchV3,
} from "./candidate-store.js";
import type { CandidateVerdict } from "./store.js";

/**
 * Verdicts and dispatch claims live in D1 rather than in the Durable Object, so
 * candidate progress can be read without waking the coordination object. These
 * are the same properties the object enforced, checked where the data actually
 * is now.
 */

const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "4".repeat(40);
const PROJECT = `proj_${REPO}`;

function verdict(over: Partial<CandidateVerdict> = {}): CandidateVerdict {
  return {
    candidateTreeOid: TREE,
    candidateSha: "3".repeat(40),
    baseSha: "1".repeat(40),
    pullRequestNumber: 42,
    accepted: true,
    resultDigest: `sha256:${"a".repeat(64)}`,
    policyDigest: `sha256:${"b".repeat(64)}`,
    suites: [{ name: "test", outcome: "passed", durationMs: 693 }],
    reasonCodes: [],
    workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    workflowSha: "5".repeat(40),
    runId: "556677",
    observedAt: "2026-07-30T20:00:00Z",
    ...over,
  };
}

function seedV3(t: ReturnType<typeof testD1>): void {
  const digest = dispatch().policyDigest;
  t.raw.prepare("UPDATE projects SET active_policy_digest = ? WHERE id = ?").run(digest, PROJECT);
  t.raw
    .prepare(
      `INSERT INTO queue_projects
         (id, organization_id, github_repository_id, base_ref, enabled,
          activation_state, project_id, verifier_protocol)
       VALUES ('queue_1', ?, ?, ?, 1, 'enforced', ?, 3)`,
    )
    .run(`org_${REPO}`, REPO, REF, PROJECT);
  t.raw
    .prepare(
      `INSERT INTO queue_state
         (github_repository_id, base_ref, generation, document, updated_at, project_id)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(REPO, REF, JSON.stringify({ state: { activeAttemptId: dispatch().attemptId } }), new Date().toISOString(), PROJECT);
}

function dispatch(over: Partial<CandidateDispatchV3> = {}): CandidateDispatchV3 {
  return {
    repositoryId: REPO,
    baseRef: REF,
    projectId: PROJECT,
    attemptId: "attempt_1",
    candidateTreeOid: TREE,
    candidateSha: "3".repeat(40),
    baseSha: "1".repeat(40),
    pullRequestNumber: 42,
    requiredSuites: ["lint", "test"],
    policyDigest: `sha256:${"b".repeat(64)}`,
    dispatchNonce: `verifier_${"1".repeat(32)}`,
    workflowCommitSha: "5".repeat(40),
    workflowBlobSha: "6".repeat(40),
    workflowContentDigest: `sha256:${"7".repeat(64)}`,
    ...over,
  };
}

describe("verifier protocol v3 storage", () => {
  const now = "2026-08-13T12:00:00.000Z";
  const later = "2026-08-13T12:05:00.000Z";

  it("preserves the callback shape of exact pre-activation workflow versions", () => {
    expect(legacyVerifierProtocol(1)).toBe(1);
    expect(legacyVerifierProtocol(2)).toBe(2);
  });

  function v3(): ReturnType<typeof testD1> {
    const t = testD1();
    open.push(t);
    seedActiveProject(t, { repositoryId: REPO });
    seedV3(t);
    return t;
  }

  async function pending(t: ReturnType<typeof testD1>) {
    expect(await claimCandidateDispatchV3(t.db, dispatch(), now, 60_000)).toBe(true);
    expect(
      await registerCandidateReport(
        t.db,
        REPO,
        dispatch().dispatchNonce,
        { runId: "900", runAttempt: 2, checkRunId: "13", jti: "oidc-jti" },
        now,
      ),
    ).toBe("registered");
    const claimed = await claimPendingCandidateReports(t.db, "tick-1", now, later, 5);
    expect(claimed).toHaveLength(1);
    return claimed[0]!;
  }

  it("registers identity without creating a verdict and makes callback replay idempotent", async () => {
    const t = v3();
    expect(await claimCandidateDispatchV3(t.db, dispatch(), now, 60_000)).toBe(true);
    const identity = { runId: "900", runAttempt: 2, checkRunId: "13", jti: "oidc-jti" };
    expect(await registerCandidateReport(t.db, REPO, dispatch().dispatchNonce, identity, now)).toBe("registered");
    expect(await candidateVerdict(t.db, REPO, REF, TREE, PROJECT)).toBeNull();
    expect(await registerCandidateReport(t.db, REPO, dispatch().dispatchNonce, identity, later)).toBe("duplicate");
    expect(
      await registerCandidateReport(t.db, REPO, dispatch().dispatchNonce, { ...identity, jti: "forged" }, later),
    ).toBe("unavailable");
    expect(() =>
      t.raw.prepare("UPDATE candidate_dispatches SET dispatch_nonce = ? WHERE dispatch_nonce = ?")
        .run(`verifier_${"9".repeat(32)}`, dispatch().dispatchNonce),
    ).toThrow(/identity is immutable/);
    expect(() =>
      t.raw.prepare("UPDATE candidate_dispatches SET report_jti = NULL WHERE dispatch_nonce = ?")
        .run(dispatch().dispatchNonce),
    ).toThrow(/identity is immutable/);
  });

  it("allows only one overlapping finalizer claim", async () => {
    const t = v3();
    await pending(t);
    expect(await claimPendingCandidateReports(t.db, "tick-2", now, later, 5)).toEqual([]);
    expect(await claimPendingCandidateReports(t.db, "tick-2", later, "2026-08-13T12:10:00.000Z", 5)).toHaveLength(1);
  });

  it("atomically records the trusted verdict and consumes the exact claim", async () => {
    const t = v3();
    const row = await pending(t);
    const trustedVerdict = verdict({ runId: row.runId });
    expect(await finalizeCandidateVerdictV3(t.db, row, "wrong-claim", trustedVerdict, later)).toBe(false);
    expect(await candidateVerdict(t.db, REPO, REF, TREE, PROJECT)).toBeNull();
    expect(await finalizeCandidateVerdictV3(t.db, row, "tick-1", trustedVerdict, later)).toBe(true);
    expect(await candidateVerdict(t.db, REPO, REF, TREE, PROJECT)).toEqual(trustedVerdict);
    expect(t.raw.prepare("SELECT finalized_at, finalizer_claim FROM candidate_dispatches").get()).toEqual({
      finalized_at: later,
      finalizer_claim: null,
    });
  });

  it("refuses the atomic verdict write after the attempt or policy changes", async () => {
    const changedAttempt = v3();
    const attemptRow = await pending(changedAttempt);
    changedAttempt.raw
      .prepare("UPDATE queue_state SET document = ? WHERE github_repository_id = ? AND base_ref = ?")
      .run(JSON.stringify({ state: { activeAttemptId: "attempt_2" } }), REPO, REF);
    expect(
      await finalizeCandidateVerdictV3(changedAttempt.db, attemptRow, "tick-1", verdict({ runId: attemptRow.runId }), later),
    ).toBe(false);

    const changedPolicy = v3();
    const policyRow = await pending(changedPolicy);
    changedPolicy.raw.prepare("UPDATE projects SET active_policy_digest = ? WHERE id = ?")
      .run(`sha256:${"9".repeat(64)}`, PROJECT);
    expect(
      await finalizeCandidateVerdictV3(changedPolicy.db, policyRow, "tick-1", verdict({ runId: policyRow.runId }), later),
    ).toBe(false);
  });

  it("rejects a callback after project release and reselection", async () => {
    const t = v3();
    expect(await claimCandidateDispatchV3(t.db, dispatch(), now, 60_000)).toBe(true);
    t.raw.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT);
    seedActiveProject(t, { repositoryId: REPO, projectId: "project_new" });
    expect(
      await registerCandidateReport(
        t.db,
        REPO,
        dispatch().dispatchNonce,
        { runId: "900", runAttempt: 2, checkRunId: "13", jti: "oidc-jti" },
        now,
      ),
    ).toBe("unavailable");
  });

  it("supersedes old callbacks and verdicts in the v3 activation transaction", async () => {
    const t = testD1();
    open.push(t);
    seedActiveProject(t, { repositoryId: REPO });
    t.raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, enabled,
            activation_state, project_id, verifier_protocol)
         VALUES ('queue_1', ?, ?, ?, 1, 'enforced', ?, 2)`,
      )
      .run(`org_${REPO}`, REPO, REF, PROJECT);
    t.raw
      .prepare(
        `INSERT INTO candidate_dispatches
           (github_repository_id, base_ref, candidate_tree_oid, dispatched_at,
            project_id, attempt_id, workflow_protocol, verifier_protocol)
         VALUES (?, ?, ?, ?, ?, 'attempt_old', 2, 2)`,
      )
      .run(REPO, REF, TREE, now, PROJECT);
    const old = verdict();
    t.raw
      .prepare(
        `INSERT INTO candidate_verdicts
           (github_repository_id, base_ref, project_id, candidate_tree_oid,
            candidate_sha, base_sha, pull_request_number, accepted, result_digest,
            policy_digest, suites, reason_codes, workflow_ref, workflow_sha,
            run_id, observed_at, verifier_protocol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
      )
      .run(
        REPO,
        REF,
        PROJECT,
        old.candidateTreeOid,
        old.candidateSha,
        old.baseSha,
        old.pullRequestNumber,
        old.accepted ? 1 : 0,
        old.resultDigest,
        old.policyDigest,
        JSON.stringify(old.suites),
        JSON.stringify(old.reasonCodes),
        old.workflowRef,
        old.workflowSha,
        old.runId,
        old.observedAt,
      );

    t.raw.prepare("UPDATE queue_projects SET verifier_protocol = 3 WHERE id = 'queue_1'").run();

    expect(t.raw.prepare("SELECT terminal_reason FROM candidate_dispatches").get()).toEqual({
      terminal_reason: "superseded by verifier protocol v3",
    });
    expect(await candidateVerdict(t.db, REPO, REF, TREE, PROJECT)).toBeNull();
    expect(() => t.raw.prepare("UPDATE queue_projects SET verifier_protocol = 2 WHERE id = 'queue_1'").run()).toThrow(
      /downgrade blocked/,
    );
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO candidate_verdicts
             (github_repository_id, base_ref, project_id, candidate_tree_oid,
              candidate_sha, base_sha, pull_request_number, accepted, result_digest,
              policy_digest, suites, reason_codes, workflow_ref, workflow_sha,
              run_id, observed_at, verifier_protocol)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '[]', '[]', ?, ?, ?, ?, 2)`,
        )
        .run(
          REPO,
          REF,
          PROJECT,
          "9".repeat(40),
          old.candidateSha,
          old.baseSha,
          old.pullRequestNumber,
          old.resultDigest,
          old.policyDigest,
          old.workflowRef,
          old.workflowSha,
          old.runId,
          old.observedAt,
        ),
    ).toThrow(/downgrade blocked/);
    expect(
      await claimCandidateDispatchV2(t.db, REPO, REF, PROJECT, "attempt_late", 2, "9".repeat(40), later, 60_000),
    ).toBe(false);
    expect(await candidateDispatchBindingV2(t.db, REPO, REF, TREE, PROJECT)).toBeNull();
    expect(await recordCandidateVerdictV2(t.db, REPO, REF, PROJECT, verdict({ candidateTreeOid: "9".repeat(40) })))
      .toEqual({ status: "unavailable" });
  });

  it("preserves exact protocol-v2 dispatches and callbacks before activation", async () => {
    const t = testD1();
    open.push(t);
    seedActiveProject(t, { repositoryId: REPO });
    t.raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, enabled,
            activation_state, project_id, verifier_protocol)
         VALUES ('queue_1', ?, ?, ?, 1, 'enforced', ?, 2)`,
      )
      .run(`org_${REPO}`, REPO, REF, PROJECT);

    expect(await claimCandidateDispatchV2(t.db, REPO, REF, PROJECT, "attempt_1", 2, TREE, now, 60_000)).toBe(true);
    await expect(candidateDispatchBindingV2(t.db, REPO, REF, TREE, PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      attemptId: "attempt_1",
      workflowProtocol: 2,
    });
    await expect(recordCandidateVerdictV2(t.db, REPO, REF, PROJECT, verdict())).resolves.toEqual({
      status: "applied",
    });
    await expect(candidateVerdict(t.db, REPO, REF, TREE, PROJECT)).resolves.toEqual(verdict());
    await expect(candidateVerdict(t.db, REPO, REF, TREE, "stale-project")).resolves.toBeNull();
  });

  it("allows a fresh v3 dispatch after a terminal finalizer refusal", async () => {
    const t = v3();
    const row = await pending(t);
    expect(await finishPendingCandidateReport(t.db, row, "tick-1", { terminalReason: "report failed" })).toBe(true);
    expect(
      await claimCandidateDispatchV3(
        t.db,
        dispatch({ dispatchNonce: `verifier_${"2".repeat(32)}` }),
        later,
        60_000,
      ),
    ).toBe(true);
  });

  it("replaces an expired pre-callback dispatch and invalidates its old nonce", async () => {
    const t = v3();
    const first = dispatch();
    const second = dispatch({ dispatchNonce: `verifier_${"2".repeat(32)}` });
    expect(await claimCandidateDispatchV3(t.db, first, now, 60_000)).toBe(true);
    expect(await claimCandidateDispatchV3(t.db, second, later, 60_000)).toBe(true);
    expect(
      await registerCandidateReport(
        t.db,
        REPO,
        first.dispatchNonce,
        { runId: "900", runAttempt: 1, checkRunId: "13", jti: "old" },
        later,
      ),
    ).toBe("unavailable");
    expect(
      await registerCandidateReport(
        t.db,
        REPO,
        second.dispatchNonce,
        { runId: "901", runAttempt: 1, checkRunId: "14", jti: "new" },
        later,
      ),
    ).toBe("registered");
  });
});
