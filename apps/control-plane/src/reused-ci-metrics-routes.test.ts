import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import type { Env } from "./env.js";

vi.mock("./queue/BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("./auth.js", () => ({
  createAuth: () => ({
    api: { getSession: async () => ({ user: { id: "ba_user_1" } }) },
    handler: async () => new Response("not used", { status: 404 }),
  }),
}));

const { default: worker } = await import("./index.js");
const opened: TestD1[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function fresh(): TestD1 {
  const t = testD1();
  opened.push(t);
  const now = new Date().toISOString();
  t.raw
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('ba_user_1', 'Alice', 'alice@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  t.raw
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES ('account_1', 'github_user_1', 'github', 'ba_user_1', ?, ?)`,
    )
    .run(now, now);
  for (const [id, githubId] of [
    ["org_1", "github_org_1"],
    ["org_2", "github_org_2"],
  ]) {
    t.raw
      .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
      .run(id, githubId, id);
  }
  t.raw
    .prepare(
      `INSERT INTO principals
         (id, organization_id, github_user_id, github_login, github_org_role, activated_at)
       VALUES ('principal_1', 'org_1', 'github_user_1', 'alice', 'owner', ?)`,
    )
    .run(now);
  t.raw
    .prepare("UPDATE queue_clock SET started_at = ?, finished_at = ?, source = 'traffic' WHERE id = 'tick'")
    .run(now, now);
  return t;
}

function measuredMerge(t: TestD1, projectId: string, organizationId: string, repositoryId: string, number: number): void {
  const head = `${number}`.repeat(40).slice(0, 40);
  const policy = `sha256:${`${number}`.repeat(64).slice(0, 64)}`;
  t.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES (?, ?, ?, ?)",
    )
    .run(projectId, organizationId, repositoryId, `${organizationId}/${projectId}`);
  t.raw
    .prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, policy_digest, verifier_version, mode, request_json,
          status, outcome, check_name, check_run_id, started_at, completed_at,
          signed_suite_duration_ms, signed_wall_clock_duration_ms, verification_duration_ms)
       VALUES (?, ?, 'pull_request', ?, 'refs/heads/main', ?, 'verifier-1', 'enforced', '{}',
               'completed', 'PASS', 'thwip', ?, '2026-08-11T10:00:00.000Z',
               '2026-08-11T10:00:00.010Z', ?, ?, ?)`,
    )
    .run(`proof_${number}`, projectId, head, policy, `check_${number}`, number * 100, number * 1_000, number * 10);
  t.raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, project_id)
       VALUES (?, 'reused-proof-merge', ?, 'refs/heads/main', ?, ?, ?, 'signed', ?)`,
    )
    .run(
      `sha256:merge${number}`,
      repositoryId,
      number,
      `attempt_${number}`,
      JSON.stringify({
        kind: "reused-proof-merge",
        reusedProof: { checkRunId: `check_${number}`, headSha: head, policyDigest: policy },
      }),
      projectId,
    );
}

async function fetch(t: TestD1, path: string): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const execution = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  const response = await worker.fetch(
    new Request(`https://thwip.test${path}`),
    { DB: t.db } as unknown as Env,
    execution,
  );
  await Promise.all(pending);
  return response;
}

describe("reused-CI metric API scopes", () => {
  it("publishes no deployment total below the public sample threshold", async () => {
    const t = fresh();
    measuredMerge(t, "project_1", "org_1", "10", 1);

    const response = await fetch(t, "/v1/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(response.json()).resolves.toEqual({ status: "insufficient-sample", minimumMergedProofs: 10 });
  });

  it("returns only the selected organization's total", async () => {
    const t = fresh();
    measuredMerge(t, "project_1", "org_1", "10", 1);
    measuredMerge(t, "project_2", "org_2", "20", 2);

    const response = await fetch(t, "/v1/dashboard/metrics");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "complete",
      mergedProofs: 1,
      signedWallClockDurationMs: 1_000,
    });
  });

  it("requires project membership or an active repository grant", async () => {
    const t = fresh();
    measuredMerge(t, "project_2", "org_2", "20", 2);

    expect((await fetch(t, "/v1/dashboard/projects/project_2/metrics")).status).toBe(404);
    t.raw
      .prepare(
        `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active)
         VALUES ('project_2', 'github_user_1', 'alice', 'read', 1)`,
      )
      .run();

    const response = await fetch(t, "/v1/dashboard/projects/project_2/metrics");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mergedProofs: 1, signedWallClockDurationMs: 2_000 });
  });
});
