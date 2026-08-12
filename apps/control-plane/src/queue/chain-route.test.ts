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
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
    commitFacts: async () => null,
    signRecordBytes: async () => "jws",
  });
}

/**
 * A project, the organization that owns it, and alice's membership of that
 * organization. Membership is what the route checks for an unpublished chain,
 * so a principal with no row in the owning organization is a stranger.
 */
async function seedProject(e: QueueRouteEnv, repositoryId: string, chainPublic: 0 | 1): Promise<void> {
  await e.DB.prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .bind("org_1", "1", "acme")
    .run();
  await e.DB.prepare(
    `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public)
     VALUES (?, 'org_1', ?, ?, 1, 'enforced', ?)`,
  )
    .bind(`qp_${repositoryId}`, repositoryId, REF, chainPublic)
    .run();
  await e.DB.prepare(
    "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, 'org_1', ?, ?, 1)",
  )
    .bind(`proj_${repositoryId}`, repositoryId, `acme/repo-${repositoryId}`)
    .run();
  await e.DB.prepare(
    "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, 'org_1', ?, ?, datetime('now'))",
  )
    .bind("alice", "1", "alice")
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

  it("returns 404 for a removed project even while partial cleanup rows remain", async () => {
    const e = env();
    await seedProject(e, PUBLIC_REPO, 1);
    await e.DB.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org_1', ?, 'now', '1')",
    )
      .bind(PUBLIC_REPO)
      .run();

    const response = await routes(false).request(
      `/v1/queue/${PUBLIC_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for a removed project's record before cleanup finishes", async () => {
    const e = env();
    await seedProject(e, PUBLIC_REPO, 1);
    const digest = `sha256:${"a".repeat(64)}`;
    await e.DB.prepare(
      "INSERT INTO queue_attestations (digest, kind, github_repository_id, base_ref, bytes, jws) VALUES (?, 'merge', ?, ?, '{}', 'jws')",
    )
      .bind(digest, PUBLIC_REPO, REF)
      .run();
    await e.DB.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org_1', ?, 'now', '1')",
    )
      .bind(PUBLIC_REPO)
      .run();

    const response = await routes(false).request(`/v1/queue/records/${digest}`, {}, e);
    expect(response.status).toBe(404);
  });

  /**
   * One message covered a bad repository id and a missing branch, and it named
   * the id. A live investigation followed it to the wrong conclusion, deciding
   * the route wanted an internal database key when the id it had was correct.
   * This is the public verification surface, so an outside auditor gets no
   * second chance to guess.
   */
  it("blames the ref, not the repository id, when the ref is malformed", async () => {
    const e = env();
    await seedProject(e, PUBLIC_REPO, 1);

    const response = await routes(false).request(`/v1/queue/${PUBLIC_REPO}/chain?ref=main`, {}, e);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("ref");
  });

  /**
   * A published chain is the artifact an outside verifier fetches. Requiring
   * them to know the branch spelling before they can read it serves nobody.
   */
  it("resolves the branch itself when a published chain is asked for without one", async () => {
    const e = env();
    await seedProject(e, PUBLIC_REPO, 1);

    const response = await routes(false).request(`/v1/queue/${PUBLIC_REPO}/chain`, {}, e);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { links: unknown[] }).links).toEqual([]);
  });

  /**
   * Resolving the branch for an unpublished chain would answer "does this
   * private repository use the queue" to anyone who asked, which is the
   * enumeration the 404 case below exists to prevent.
   */
  it("will not resolve a branch for a chain that has not been published", async () => {
    const e = env();
    await seedProject(e, PRIVATE_REPO, 0);

    const response = await routes(false).request(`/v1/queue/${PRIVATE_REPO}/chain`, {}, e);

    expect(response.status).toBe(400);
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

  /**
   * 404 is a member's answer, not a stranger's. It says the branch this member
   * asked about has no queue, and saying that to anyone who asked is what let
   * an unauthenticated caller enumerate onboarded private repositories.
   */
  it("404s for a member asking about a branch with no queue project at all", async () => {
    const e = env();
    await e.DB.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'acme')")
      .bind()
      .run();
    await e.DB.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('proj_1', 'org_1', ?, 'acme/repo', 1)",
    )
      .bind(PRIVATE_REPO)
      .run();
    await e.DB.prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES ('alice', 'org_1', '1', 'alice', datetime('now'))",
    )
      .bind()
      .run();

    const response = await routes(true).request(
      `/v1/queue/${PRIVATE_REPO}/chain?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );
    expect(response.status).toBe(404);
  });
});
