import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * The chain endpoint used to serve any numeric repository id with no
 * authentication at all. A merge record carries pull request numbers, head
 * and base SHAs, tree oids, actor GitHub ids and free-text override reasons —
 * public for a public repository, and nobody else's business for a private
 * one. Publication is opt-in per project, and this checks both sides: a
 * project that opted in serves unauthenticated, and one that did not refuses
 * an unauthenticated caller and serves an authenticated one.
 */

const open: Array<{ close(): void }> = [];

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const PUBLIC_REPO = "1315419165";
const PRIVATE_REPO = "9988776655";
const REF = "refs/heads/main";

function routes(authOk: boolean) {
  return queueRoutes({
    authenticate: async () =>
      authOk
        ? { ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }
        : { ok: false, status: 401 },
    verifyOidc: async () => null,
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => null,
    principalFor: async () => null,
    driveTurn: async () => {},
    commitFacts: async () => null,
    signRecordBytes: async () => "jws",
  });
}

async function seedProject(e: QueueRouteEnv, repositoryId: string, chainPublic: 0 | 1): Promise<void> {
  await e.DB.prepare(
    `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public)
     VALUES (?, 'org_1', ?, ?, 1, 'enforced', ?)`,
  )
    .bind(`qp_${repositoryId}`, repositoryId, REF, chainPublic)
    .run();
}

describe("GET /v1/queue/:repositoryId/chain", () => {
  it("serves a public project without authentication", async () => {
    const e = env();
    await seedProject(e, PUBLIC_REPO, 1);

    const response = await routes(false).request(
      `/v1/queue/${PUBLIC_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { links: unknown[] };
    expect(body.links).toEqual([]);
  });

  it("refuses an unauthenticated caller for a project that has not opted in", async () => {
    const e = env();
    await seedProject(e, PRIVATE_REPO, 0);

    const response = await routes(false).request(
      `/v1/queue/${PRIVATE_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );

    expect(response.status).toBe(401);
  });

  it("serves a private project to an authenticated caller", async () => {
    const e = env();
    await seedProject(e, PRIVATE_REPO, 0);

    const response = await routes(true).request(
      `/v1/queue/${PRIVATE_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { links: unknown[] };
    expect(body.links).toEqual([]);
  });

  it("404s for a branch with no queue project at all", async () => {
    const e = env();
    const response = await routes(false).request(
      `/v1/queue/${PRIVATE_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );
    expect(response.status).toBe(404);
  });
});
