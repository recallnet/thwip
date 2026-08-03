import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { REPOSITORY_FORBIDDEN, REPOSITORY_READ_ONLY } from "./repository-access.js";

/**
 * People who hold a repository without belonging to the organization that owns
 * it.
 *
 * GitHub invites them one repository at a time and gives each invitation a
 * permission. thwip had no way to say that: `mayActOnRepository` compared the
 * caller's principal's organization to the project's, so an invitation was
 * worth nothing, and an `outside` principal, which installation sync has always
 * written for a collaborator, was worth the whole organization.
 *
 * Both halves are here. What a grant buys, and what it does not buy anywhere
 * else.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

/** The repository the collaborator was invited to. */
const GRANTED_REPO = "1315419165";
/** Another repository in the same organization, which they were not invited to. */
const SIBLING_REPO = "2426530276";
/** A repository nobody has onboarded, for the enumeration case. */
const ABSENT_REPO = "4242424242";
const REF = "refs/heads/main";

function seed(): void {
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_acme", "10", "acme");
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_bravo", "20", "bravo");
  for (const [id, repositoryId, name] of [
    ["proj_acme", GRANTED_REPO, "acme/repo"],
    ["proj_acme_sibling", SIBLING_REPO, "acme/other"],
  ] as const) {
    raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run(id, "org_acme", repositoryId, name);
    raw
      .prepare(
        `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public)
         VALUES (?, ?, ?, ?, 1, 'enforced', 0)`,
      )
      .run(`qp_${id}`, "org_acme", repositoryId, REF);
  }
  // The shadow principal installation sync writes for anyone with a grant. It
  // sits in the owning organization and says, in `github_org_role`, that being
  // there is not membership.
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role) VALUES (?, ?, ?, ?, 'outside')",
    )
    .run("prn_outside", "org_acme", "31", "olive");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role, activated_at) VALUES (?, ?, ?, ?, 'member', datetime('now'))",
    )
    .run("prn_bravo", "org_bravo", "21", "bruno");
}

function grant(permission: string, projectId = "proj_acme", githubUserId = "31"): void {
  raw
    .prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES (?, ?, ?, ?, 1)",
    )
    .run(projectId, githubUserId, "olive", permission);
}

const dispatched: number[] = [];

function routes(session: { principalId: string; githubUserId: string; isAdmin?: boolean } | null) {
  dispatched.length = 0;
  return queueRoutes({
    authenticate: async () =>
      session === null
        ? { ok: false, status: 401 }
        : {
            ok: true,
            principalId: session.principalId,
            githubUserId: session.githubUserId,
            isAdmin: session.isAdmin ?? false,
          },
    verifyOidc: async () => null,
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async () => null,
    pullRequestPlacement: async () => ({ authorGithubUserId: "31", baseRef: REF, authorIsBot: false }),
    driveTurn: async (_e, _r, pullRequestNumber) => {
      dispatched.push(pullRequestNumber);
    },
    commitFacts: async () => null,
    signRecordBytes: async () => "jws",
  });
}

const OLIVE = { principalId: "prn_outside", githubUserId: "31" };
const BRUNO = { principalId: "prn_bravo", githubUserId: "21" };

type Route = { name: string; method: string; path: (id: string) => string; body?: Record<string, unknown> };

const READ: Route = {
  name: "read the queue",
  method: "GET",
  path: (id) => `/v1/queue/${id}?ref=${encodeURIComponent(REF)}`,
};
const QUEUE_A_PULL_REQUEST: Route = {
  name: "join the queue",
  method: "POST",
  path: (id) => `/v1/queue/${id}/entries?ref=${encodeURIComponent(REF)}`,
  body: { pullRequestNumber: 7, headSha: "a".repeat(40) },
};
const PAUSE: Route = {
  name: "pause the queue",
  method: "POST",
  path: (id) => `/v1/queue/${id}/pause?ref=${encodeURIComponent(REF)}`,
  body: { reason: "the base moved" },
};

function call(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  route: Route,
  repositoryId = GRANTED_REPO,
): Promise<Response> {
  return app.request(
    route.path(repositoryId),
    route.body === undefined
      ? { method: route.method }
      : { method: route.method, headers: { "content-type": "application/json" }, body: JSON.stringify(route.body) },
    e,
  );
}

async function refusal(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? "";
}

describe("an outside collaborator with write", () => {
  it("may queue a pull request on the repository they hold", async () => {
    const e = env();
    seed();
    grant("write");

    const response = await call(routes(OLIVE), e, QUEUE_A_PULL_REQUEST);

    expect(await refusal(response)).not.toBe(REPOSITORY_FORBIDDEN);
    expect(response.status).not.toBe(403);
  });

  it("may read the queue", async () => {
    const e = env();
    seed();
    grant("write");

    const response = await call(routes(OLIVE), e, READ);

    expect(response.status).toBe(200);
  });

  /**
   * Write is what GitHub requires to push, and it is the floor for queueing.
   * Pausing a lane everybody else is waiting in is not something an invitation
   * to push buys.
   */
  it("may not pause the queue", async () => {
    const e = env();
    seed();
    grant("write");

    const response = await call(routes(OLIVE), e, PAUSE);

    expect(response.status).toBe(403);
    expect(await refusal(response)).toBe("repository admin required");
  });

  /**
   * The invitation is to one repository. The `outside` principal sits in the
   * organization that owns it, and reading membership off that row is what
   * would turn one invitation into every repository the organization has.
   */
  it("reaches nothing on another repository of the same organization", async () => {
    const e = env();
    seed();
    grant("write");
    const app = routes(OLIVE);

    const sibling = await call(app, e, READ, SIBLING_REPO);
    const absent = await call(app, e, READ, ABSENT_REPO);

    expect(sibling.status).toBe(403);
    expect(sibling.status).toBe(absent.status);
    expect(await sibling.text()).toBe(await absent.text());
  });
});

describe("an outside collaborator with maintain", () => {
  it("may queue a pull request", async () => {
    const e = env();
    seed();
    grant("maintain");

    const response = await call(routes(OLIVE), e, QUEUE_A_PULL_REQUEST);

    expect(await refusal(response)).not.toBe(REPOSITORY_FORBIDDEN);
    expect(response.status).not.toBe(403);
  });
});

describe("an outside collaborator with admin", () => {
  it("may pause the queue of the repository they administer", async () => {
    const e = env();
    seed();
    grant("admin");

    const response = await call(routes(OLIVE), e, PAUSE);

    const error = await refusal(response);
    expect(error).not.toBe(REPOSITORY_FORBIDDEN);
    expect(error).not.toBe("repository admin required");
  });

  /** Administering one repository is not administering the one next to it. */
  it("may not pause another repository of the same organization", async () => {
    const e = env();
    seed();
    grant("admin");

    const response = await call(routes(OLIVE), e, PAUSE, SIBLING_REPO);

    expect(response.status).toBe(403);
    expect(await refusal(response)).toBe(REPOSITORY_FORBIDDEN);
  });
});

describe("an outside collaborator with triage", () => {
  it("may read the queue", async () => {
    const e = env();
    seed();
    grant("triage");

    const response = await call(routes(OLIVE), e, READ);

    expect(response.status).toBe(200);
  });

  /**
   * Refused for what they lack rather than for the repository's existence.
   * Saying so is safe here and only here: a caller holding triage has already
   * been told by GitHub that the repository is there, so the refusal discloses
   * nothing the invitation did not.
   */
  it("may not queue a pull request, and is told which permission it takes", async () => {
    const e = env();
    seed();
    grant("triage");

    const response = await call(routes(OLIVE), e, QUEUE_A_PULL_REQUEST);

    expect(response.status).toBe(403);
    expect(await refusal(response)).toBe(REPOSITORY_READ_ONLY);
    expect(dispatched).toEqual([]);
  });
});

describe("a collaborator whose grant was withdrawn", () => {
  it("learns nothing about the repository, exactly as for one that does not exist", async () => {
    const e = env();
    seed();
    raw
      .prepare(
        "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES (?, ?, ?, 'write', 0)",
      )
      .run("proj_acme", "31", "olive");
    const app = routes(OLIVE);

    const held = await call(app, e, READ);
    const absent = await call(app, e, READ, ABSENT_REPO);

    expect(held.status).toBe(403);
    expect(held.status).toBe(absent.status);
    expect(await held.text()).toBe(await absent.text());
  });
});

/**
 * A grant belongs to a person, so it is read by GitHub user id rather than
 * through whichever principal the session happens to have selected. A member of
 * another organization holding no grant is refused for the same reason they
 * always were.
 */
describe("a member of another organization", () => {
  it("reaches nothing here through the collaborator path", async () => {
    const e = env();
    seed();
    grant("admin");
    const app = routes({ ...BRUNO, isAdmin: true });

    const response = await call(app, e, READ);
    const absent = await call(app, e, READ, ABSENT_REPO);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(await absent.text());
  });

  it("may act on a repository they were separately invited to", async () => {
    const e = env();
    seed();
    grant("write", "proj_acme", "21");

    const response = await call(routes(BRUNO), e, QUEUE_A_PULL_REQUEST);

    expect(await refusal(response)).not.toBe(REPOSITORY_FORBIDDEN);
    expect(response.status).not.toBe(403);
  });
});
