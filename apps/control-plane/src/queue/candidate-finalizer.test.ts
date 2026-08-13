import { afterEach, describe, expect, it } from "vitest";
import {
  deriveGithubCandidateVerdict,
  finalizeCandidateReports,
  type GithubWorkflowJob,
} from "./candidate-finalizer.js";
import {
  candidateVerdict,
  claimCandidateDispatchV3,
  registerCandidateReport,
  type PendingCandidateFinalization,
} from "./candidate-store.js";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import type { QueueRouteEnv } from "./routes.js";

const SHA = "a".repeat(40);
const pending: PendingCandidateFinalization = {
  repositoryId: "1",
  baseRef: "refs/heads/main",
  projectId: "project_1",
  attemptId: "attempt_1",
  candidateTreeOid: "b".repeat(40),
  candidateSha: "c".repeat(40),
  baseSha: "d".repeat(40),
  pullRequestNumber: 7,
  requiredSuites: ["lint", "test"],
  policyDigest: `sha256:${"8".repeat(64)}`,
  dispatchNonce: `verifier_${"1".repeat(32)}`,
  workflowCommitSha: SHA,
  workflowBlobSha: "e".repeat(40),
  workflowContentDigest: `sha256:${"f".repeat(64)}`,
  runId: "900",
  runAttempt: 2,
  checkRunId: "13",
  pendingAt: "2026-08-13T12:00:00.000Z",
};

const run = {
  id: 900,
  run_attempt: 2,
  event: "repository_dispatch",
  path: ".github/workflows/thwip-queue-verify.yml",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
};

function job(
  id: number,
  name: string,
  conclusion: string | null = "success",
  status = "completed",
): GithubWorkflowJob {
  return {
    id,
    run_id: 900,
    name,
    status,
    conclusion,
    head_sha: SHA,
    started_at: "2026-08-13T12:00:00.000Z",
    completed_at: status === "completed" ? "2026-08-13T12:00:02.000Z" : null,
  };
}

const completeJobs = [
  job(10, "prepare trusted suite matrix"),
  job(11, "verify candidate / lint"),
  job(12, "verify candidate / test"),
  job(13, "register trusted candidate report"),
];

const open: Array<{ close(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("trusted candidate result derivation", () => {
  it("does not create a verdict before the signed report job completes", () => {
    const jobs = completeJobs.map((value) =>
      value.id === 13 ? job(13, value.name, null, "in_progress") : value,
    );
    expect(deriveGithubCandidateVerdict(pending, { ...run, status: "in_progress" }, jobs)).toEqual({
      kind: "waiting",
      detail: "workflow run is not complete",
    });
  });

  it("accepts only the exact GitHub-owned matrix set", () => {
    expect(deriveGithubCandidateVerdict(pending, run, completeJobs)).toMatchObject({
      kind: "complete",
      accepted: true,
      suites: [
        { name: "lint", outcome: "passed", durationMs: 2000 },
        { name: "test", outcome: "passed", durationMs: 2000 },
      ],
    });
  });

  it("turns a GitHub-owned suite failure into a refusal", () => {
    const jobs = completeJobs.map((value) =>
      value.name === "verify candidate / test" ? job(value.id, value.name, "failure") : value,
    );
    expect(deriveGithubCandidateVerdict(pending, { ...run, conclusion: "failure" }, jobs)).toMatchObject({
      kind: "complete",
      accepted: false,
      suites: expect.arrayContaining([{ name: "test", outcome: "failed", durationMs: 2000 }]),
    });
  });

  it.each([
    {
      name: "duplicate matrix retry",
      jobs: [...completeJobs, job(99, "verify candidate / test")],
      detail: "suite job test is missing or ambiguous",
    },
    {
      name: "unexpected job",
      jobs: [...completeJobs, job(99, "candidate controlled output")],
      detail: "the run contains an unexpected workflow job",
    },
    {
      name: "wrong signed report job",
      jobs: completeJobs.map((value) => value.id === 13 ? job(99, value.name) : value),
      detail: "the signed report job is missing or ambiguous",
    },
    {
      name: "failed report job",
      jobs: completeJobs.map((value) => value.id === 13 ? job(13, value.name, "failure") : value),
      detail: "report job did not complete successfully",
    },
  ])("fails closed on $name", ({ jobs, detail }) => {
    expect(deriveGithubCandidateVerdict(pending, run, jobs)).toEqual({ kind: "terminal", detail });
  });

  it("rejects a retry or commit outside the dispatch binding", () => {
    expect(deriveGithubCandidateVerdict(pending, { ...run, run_attempt: 3 }, completeJobs)).toMatchObject({
      kind: "terminal",
    });
    expect(deriveGithubCandidateVerdict(pending, { ...run, head_sha: "9".repeat(40) }, completeJobs)).toMatchObject({
      kind: "terminal",
    });
  });
});

describe("scheduled trusted finalization", () => {
  function setup() {
    const t = testD1();
    open.push(t);
    seedActiveProject(t, { repositoryId: pending.repositoryId, projectId: pending.projectId });
    const digest = pending.policyDigest;
    t.raw.prepare("UPDATE projects SET active_policy_digest = ? WHERE id = ?").run(digest, pending.projectId);
    t.raw
      .prepare(
        `INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status)
         VALUES (?, ?, 1, ?, 'active')`,
      )
      .run(
        digest,
        pending.projectId,
        JSON.stringify({
          schemaVersion: "1",
          version: 1,
          securityProfile: "audited",
          pipeline: {
            digest: `sha256:${"9".repeat(64)}`,
            runner: "command",
            requiredSuites: pending.requiredSuites,
          },
        }),
      );
    t.raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, enabled, activation_state,
            project_id, verifier_protocol, verifier_json)
         VALUES ('queue_1', ?, ?, ?, 1, 'enforced', ?, 3, ?)`,
      )
      .run(
        `org_${pending.repositoryId}`,
        pending.repositoryId,
        pending.baseRef,
        pending.projectId,
        JSON.stringify({
          workflowRef: `test/repository-${pending.repositoryId}/.github/workflows/thwip-queue-verify.yml@refs/heads/main`,
          workflowSha: null,
        }),
      );
    t.raw
      .prepare(
        `INSERT INTO queue_state
           (github_repository_id, base_ref, generation, document, updated_at, project_id)
         VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        pending.repositoryId,
        pending.baseRef,
        JSON.stringify({ state: { activeAttemptId: pending.attemptId } }),
        pending.pendingAt,
        pending.projectId,
      );
    return { t, digest };
  }

  async function register(t: ReturnType<typeof testD1>) {
    expect(
      await claimCandidateDispatchV3(
        t.db,
        {
          ...pending,
          requiredSuites: [...pending.requiredSuites],
        },
        pending.pendingAt,
        60_000,
      ),
    ).toBe(true);
    expect(
      await registerCandidateReport(
        t.db,
        pending.repositoryId,
        pending.dispatchNonce,
        {
          runId: pending.runId,
          runAttempt: pending.runAttempt,
          checkRunId: pending.checkRunId,
          jti: "trusted-jti",
        },
        pending.pendingAt,
      ),
    ).toBe("registered");
  }

  it("creates no verdict until a later trusted tick sees the completed exact GitHub job set", async () => {
    const { t } = setup();
    await register(t);
    let githubReads = 0;
    const published: boolean[] = [];
    const deps = {
      activeAttempt: async () => pending.attemptId,
      publish: async (_row: PendingCandidateFinalization, result: { accepted: boolean }) => {
        published.push(result.accepted);
      },
      drive: async () => undefined,
      githubState: async () => {
        githubReads += 1;
        return githubReads === 1
          ? ({ kind: "waiting", detail: "GitHub has not indexed the jobs yet" } as const)
          : ({ kind: "ready", run, jobs: completeJobs } as const);
      },
    };
    const env = { DB: t.db, PUBLIC_ORIGIN: "https://thwip.ai" } as unknown as QueueRouteEnv;

    await expect(finalizeCandidateReports(env, deps, new Date(pending.pendingAt))).resolves.toEqual({
      finalized: 0,
      retried: 1,
      terminal: 0,
    });
    expect(await candidateVerdict(t.db, pending.repositoryId, pending.baseRef, pending.candidateTreeOid)).toBeNull();

    await expect(finalizeCandidateReports(env, deps, new Date("2026-08-13T12:01:01.000Z"))).resolves.toEqual({
      finalized: 1,
      retried: 0,
      terminal: 0,
    });
    expect(await candidateVerdict(t.db, pending.repositoryId, pending.baseRef, pending.candidateTreeOid)).toMatchObject({
      accepted: true,
      runId: pending.runId,
      workflowSha: pending.workflowCommitSha,
      suites: [
        { name: "lint", outcome: "passed", durationMs: 2000 },
        { name: "test", outcome: "passed", durationMs: 2000 },
      ],
    });
    expect(published).toEqual([true]);
  });

  it("does not credit a completed run to a policy changed after dispatch", async () => {
    const { t } = setup();
    await register(t);
    const changedDigest = `sha256:${"7".repeat(64)}`;
    t.raw
      .prepare(
        `INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status)
         VALUES (?, ?, 2, ?, 'active')`,
      )
      .run(
        changedDigest,
        pending.projectId,
        JSON.stringify({
          schemaVersion: "1",
          version: 2,
          securityProfile: "audited",
          pipeline: {
            digest: `sha256:${"6".repeat(64)}`,
            runner: "command",
            requiredSuites: pending.requiredSuites,
          },
        }),
      );
    t.raw.prepare("UPDATE projects SET active_policy_digest = ? WHERE id = ?").run(changedDigest, pending.projectId);
    const env = { DB: t.db, PUBLIC_ORIGIN: "https://thwip.ai" } as unknown as QueueRouteEnv;

    await expect(
      finalizeCandidateReports(
        env,
        {
          activeAttempt: async () => pending.attemptId,
          publish: async () => undefined,
          drive: async () => undefined,
          githubState: async () => ({ kind: "ready", run, jobs: completeJobs }),
        },
        new Date(pending.pendingAt),
      ),
    ).resolves.toEqual({ finalized: 0, retried: 0, terminal: 1 });
    await expect(candidateVerdict(t.db, pending.repositoryId, pending.baseRef, pending.candidateTreeOid)).resolves.toBeNull();
    expect(t.raw.prepare("SELECT terminal_reason AS reason FROM candidate_dispatches").get()).toEqual({
      reason: "active policy no longer matches the dispatch",
    });
  });

  it("still drives the queue when the informational check write fails after finalization", async () => {
    const { t } = setup();
    await register(t);
    let drives = 0;
    const env = { DB: t.db, PUBLIC_ORIGIN: "https://thwip.ai" } as unknown as QueueRouteEnv;

    await expect(
      finalizeCandidateReports(
        env,
        {
          activeAttempt: async () => pending.attemptId,
          publish: async () => { throw new Error("GitHub unavailable"); },
          drive: async () => { drives += 1; },
          githubState: async () => ({ kind: "ready", run, jobs: completeJobs }),
        },
        new Date(pending.pendingAt),
      ),
    ).resolves.toEqual({ finalized: 1, retried: 0, terminal: 0 });
    expect(drives).toBe(1);
    await expect(candidateVerdict(t.db, pending.repositoryId, pending.baseRef, pending.candidateTreeOid)).resolves.toMatchObject({
      accepted: true,
    });
  });

  it("refuses when the attempt changes while GitHub results are being read", async () => {
    const { t } = setup();
    await register(t);
    const activeAttempt = async () => {
      const row = t.raw
        .prepare("SELECT json_extract(document, '$.state.activeAttemptId') AS id FROM queue_state")
        .get() as { id: string | null };
      return row.id;
    };
    const env = { DB: t.db, PUBLIC_ORIGIN: "https://thwip.ai" } as unknown as QueueRouteEnv;

    await expect(
      finalizeCandidateReports(
        env,
        {
          activeAttempt,
          publish: async () => undefined,
          drive: async () => undefined,
          githubState: async () => {
            t.raw.prepare("UPDATE queue_state SET document = ?")
              .run(JSON.stringify({ state: { activeAttemptId: "attempt_2" } }));
            return { kind: "ready", run, jobs: completeJobs } as const;
          },
        },
        new Date(pending.pendingAt),
      ),
    ).resolves.toEqual({ finalized: 0, retried: 0, terminal: 1 });
    await expect(candidateVerdict(t.db, pending.repositoryId, pending.baseRef, pending.candidateTreeOid)).resolves.toBeNull();
  });
});
