import { afterEach, describe, expect, it } from "vitest";

import { testD1 } from "../../test/d1.js";
import type { D1Like } from "./projection.js";
import { withQueueState } from "./queue-state.js";
import { diagnose } from "./queue-operations.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";

/**
 * Merge writes, in the call that explains the queue.
 *
 * Four merges landed on this repository with no record. Finding them took a
 * remote SQL statement against the live database, digging the merge operations
 * out of `queue_state.document` with `json_each`, because no route reports
 * them. That statement is written down in two plan documents, which is how a
 * credential that can also run `DELETE` became the documented way to diagnose
 * production.
 *
 * `/explain` already reports attempts and their outcomes. A write outlives its
 * attempt on purpose — the attempt is exactly what a stranded write cannot rely
 * on — so reporting attempts alone leaves the one thing that was needed out.
 */
const IDENTITY = { queueKey: "qk", repositoryId: "1315419165", baseRef: "refs/heads/main" };

const write = (operationId: string, at: string) => ({
  operationId,
  attemptId: `att_${operationId}`,
  attemptRevision: 1,
  expectedBaseSha: "b".repeat(40),
  expectedHeadSha: "h".repeat(40),
  expectedTreeOid: "t".repeat(40),
  pullRequestNumber: 42,
  at,
});

describe("what /explain says about merge writes", () => {
  it("names a write nobody resolved, which is the shape of the four that stranded", () => {
    const store = SnapshotQueueStore.open(cellOf(), IDENTITY);
    store.beginMergeOperation(write("op-1", "2026-08-02T12:20:00Z"));

    const report = diagnose(store);

    expect(report.mergeOperations).toEqual([
      expect.objectContaining({
        operationId: "op-1",
        attemptId: "att_op-1",
        pullRequestNumber: 42,
        writeStartedAt: "2026-08-02T12:20:00Z",
        outcome: null,
        resolvedAt: null,
      }),
    ]);
  });

  it("says how a settled write settled, so the reader can tell the two apart", async () => {
    const store = SnapshotQueueStore.open(cellOf(), IDENTITY);
    store.beginMergeOperation(write("op-1", "2026-08-02T12:20:00Z"));
    await store.resolveMergeOperation("op-1", "MERGED", "2026-08-02T12:21:00Z");

    const [row] = diagnose(store).mergeOperations;

    expect(row).toMatchObject({ operationId: "op-1", outcome: "MERGED", resolvedAt: "2026-08-02T12:21:00Z" });
  });

  it("reports the writes oldest first, because that is the order they have to be worked through", () => {
    const store = SnapshotQueueStore.open(cellOf(), IDENTITY);
    store.beginMergeOperation(write("op-2", "2026-08-02T13:00:00Z"));
    store.beginMergeOperation(write("op-1", "2026-08-02T12:00:00Z"));

    expect(diagnose(store).mergeOperations.map((o) => o.operationId)).toEqual(["op-1", "op-2"]);
  });

  it("says the queue has no writes rather than leaving the field out", () => {
    expect(diagnose(SnapshotQueueStore.open(cellOf(), IDENTITY)).mergeOperations).toEqual([]);
  });
});

/**
 * The point of all this is the HTTP call. A field on a domain type nothing
 * serves leaves a contributor back at the database.
 */
describe("what a contributor gets over HTTP", () => {
  const open: Array<{ close(): void }> = [];
  let raw: import("better-sqlite3").Database;

  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });

  function env(): QueueRouteEnv {
    const t = testD1();
    open.push(t);
    raw = t.raw;
    return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
  }

  function seed(): void {
    raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_1", "1", "acme");
    raw
      .prepare(
        `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
         VALUES ('qp_1', 'org_1', ?, ?, 1, 'enforced')`,
      )
      .run(IDENTITY.repositoryId, IDENTITY.baseRef);
    raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('proj_1', 'org_1', ?, 'acme/repo', 1)",
      )
      .run(IDENTITY.repositoryId);
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES ('alice', 'org_1', '1', 'alice', datetime('now'))",
      )
      .run();
  }

  const routes = () =>
    queueRoutes({
      authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }),
      verifyOidc: async () => null,
      pinnedVerifier: async () => null,
      activePolicy: async () => null,
      dispatchCandidateVerification: async () => ({ ok: true }),
      queueProject: async () => ({ activationState: "enforced" }),
      principalFor: async () => null,
      pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: IDENTITY.baseRef, authorIsBot: false }),
      commitFacts: async () => null,
    });

  it("hands a stranded merge write to anyone who can read the repository", async () => {
    const e = env();
    seed();
    await withQueueState(e.DB as unknown as D1Like, IDENTITY.repositoryId, IDENTITY.baseRef, (store) => {
      store.beginMergeOperation(write("op-1", "2026-08-02T12:20:00Z"));
    });

    const response = await routes().request(
      `/v1/queue/${IDENTITY.repositoryId}/explain?ref=${encodeURIComponent(IDENTITY.baseRef)}`,
      {},
      e,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { mergeOperations: Array<{ operationId: string; outcome: string | null }> };
    expect(body.mergeOperations).toEqual([expect.objectContaining({ operationId: "op-1", outcome: null })]);
  });
});
