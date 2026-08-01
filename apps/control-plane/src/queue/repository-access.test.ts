import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { REPOSITORY_FORBIDDEN } from "./repository-access.js";

/**
 * Being signed in is not the same as being allowed to see a repository.
 *
 * `authenticate` establishes that a caller holds a session as some principal in
 * some organization. It has never established that the caller may act on the
 * repository named in the path, and two routes added on 2026-07-31 took it as
 * though it had. The heartbeat route was the expensive one: it writes the
 * victim's queue document and then dispatches `repository_dispatch` on the
 * victim's repository, so a stranger with any account could spend another
 * organization's Actions minutes, one run per grace window, forever.
 *
 * Everything here is written from the caller's side, through the HTTP surface,
 * because the property being protected is a response and not a helper's return
 * value.
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

/** Acme's repository. Every attack below is aimed at this one. */
const VICTIM_REPO = "1315419165";
/** A repository nobody has onboarded, for the enumeration case. */
const ABSENT_REPO = "4242424242";
const REF = "refs/heads/main";

/** A device id shaped the way `thwip queue work` actually sends one. */
const DEVICE = `SHA256:${"a".repeat(43)}`;

/**
 * Two organizations, each with one principal, and a queue on Acme's repository
 * only. Bravo's principal is a perfectly ordinary signed-in user who happens
 * not to be in Acme.
 */
function seed(chainPublic: 0 | 1 = 0): void {
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_acme", "10", "acme");
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_bravo", "20", "bravo");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_acme", "org_acme", VICTIM_REPO, "acme/repo");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public)
       VALUES (?, ?, ?, ?, 1, 'enforced', ?)`,
    )
    .run("qp_acme", "org_acme", VICTIM_REPO, REF, chainPublic);
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("prn_acme", "org_acme", "11", "amelia");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("prn_bravo", "org_bravo", "21", "bruno");
}

/** Every dispatch the routes asked GitHub for, so a refusal can be shown to cost nothing. */
const dispatched: number[] = [];

function routes(
  session: { principalId: string; githubUserId: string; isAdmin?: boolean } | null,
  verifyOidc: () => Promise<Record<string, unknown> | null> = async () => null,
) {
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
    verifyOidc,
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async () => null,
    driveTurn: async (_e, _r, pullRequestNumber) => {
      dispatched.push(pullRequestNumber);
    },
    commitFacts: async () => null,
    signRecordBytes: async () => "jws",
  });
}

const ACME = { principalId: "prn_acme", githubUserId: "11" };
const BRAVO = { principalId: "prn_bravo", githubUserId: "21" };

function heartbeat(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  repositoryId = VICTIM_REPO,
  deviceKeyId: string = DEVICE,
) {
  return app.request(
    `/v1/queue/${repositoryId}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId }) },
    e,
  );
}

function chain(app: ReturnType<typeof routes>, e: QueueRouteEnv, repositoryId = VICTIM_REPO) {
  return app.request(`/v1/queue/${repositoryId}/chain?ref=${encodeURIComponent(REF)}`, {}, e);
}

describe("POST /v1/queue/:repositoryId/runners/heartbeat", () => {
  it("refuses a principal from another organization, and dispatches nothing", async () => {
    const e = env();
    seed();

    const response = await heartbeat(routes(BRAVO), e);

    expect(response.status).toBe(403);
    expect(dispatched).toEqual([]);
    // The heartbeat row is the compare-and-swap's trigger, so a refusal that
    // still wrote one would only move the cost by one call.
    const rows = raw.prepare("SELECT COUNT(*) AS n FROM queue_runners").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("serves a principal of the organization that owns the repository", async () => {
    const e = env();
    seed();

    const response = await heartbeat(routes(ACME), e);

    expect(response.status).toBe(200);
    const rows = raw.prepare("SELECT principal_id AS principalId FROM queue_runners").all() as Array<{
      principalId: string;
    }>;
    expect(rows).toEqual([{ principalId: "prn_acme" }]);
  });

  it("refuses a device id that is not shaped like one this deployment issues", async () => {
    const e = env();
    seed();

    const response = await heartbeat(routes(ACME), e, VICTIM_REPO, "d1");

    expect(response.status).toBe(400);
    const rows = raw.prepare("SELECT COUNT(*) AS n FROM queue_runners").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("refuses a device this deployment has already seen bound to somebody else", async () => {
    const e = env();
    seed();
    raw
      .prepare(
        "INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(DEVICE, "11", "ssh-ed25519", "ssh-ed25519 AAAA", DEVICE, "amelia's laptop");

    // Amelia's own device, claimed by Amelia: allowed.
    expect((await heartbeat(routes(ACME), e)).status).toBe(200);

    // The same device claimed by another member of the same organization.
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run("prn_acme_2", "org_acme", "12", "adam");
    const response = await heartbeat(routes({ principalId: "prn_acme_2", githubUserId: "12" }), e);

    expect(response.status).toBe(403);
  });
});

describe("the operator token", () => {
  /**
   * `requireAdmin`'s token authenticates as "operator", which is not a
   * principal in any organization and so has no membership row to compare.
   * Refusing it would take the chain away from the person diagnosing a stuck
   * queue at 3am, which is the reason the token exists.
   */
  it("reads a private chain despite belonging to no organization", async () => {
    const e = env();
    seed(0);
    const app = queueRoutes({
      authenticate: async () => ({
        ok: true,
        principalId: "operator",
        githubUserId: "0",
        isAdmin: true,
        operator: true,
      }),
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

    const response = await app.request(`/v1/queue/${VICTIM_REPO}/chain?ref=${encodeURIComponent(REF)}`, {}, e);

    expect(response.status).toBe(200);
  });
});

describe("GET /v1/queue/:repositoryId/chain", () => {
  it("refuses a principal from another organization on a chain that is not public", async () => {
    const e = env();
    seed(0);

    const response = await chain(routes(BRAVO), e);

    expect(response.status).toBe(403);
  });

  it("serves a principal of the organization that owns the repository", async () => {
    const e = env();
    seed(0);

    const response = await chain(routes(ACME), e);

    expect(response.status).toBe(200);
    expect((await response.json()) as { links: unknown[] }).toMatchObject({ links: [] });
  });

  it("serves a published chain with no session at all", async () => {
    const e = env();
    seed(1);

    const response = await chain(routes(null), e);

    expect(response.status).toBe(200);
    expect((await response.json()) as { links: unknown[] }).toMatchObject({ links: [] });
  });

  /**
   * The 404 used to come out before the publication check, so a caller with no
   * session could walk the numeric repository id space and read back which
   * private repositories are onboarded — and, from the ref they had to guess,
   * which branches those repositories queue.
   */
  it("answers a repository that does not exist exactly as it answers a private one", async () => {
    const e = env();
    seed(0);
    const app = routes(null);

    const absent = await chain(app, e, ABSENT_REPO);
    const priv = await chain(app, e, VICTIM_REPO);

    expect(absent.status).toBe(priv.status);
    expect(await absent.text()).toBe(await priv.text());
    expect(absent.status).toBe(401);
  });
});

/**
 * Every route that names a repository, and what it takes to reach it.
 *
 * Written as a table rather than as thirteen hand-written cases because the
 * defect was per-route bookkeeping: a route that forgets is the bug, so the
 * test has to fail when a route is added and not listed. Each entry is asked
 * for by a principal of Bravo, who is a perfectly ordinary signed-in user with
 * no membership of Acme.
 */
const MEMBER_ROUTES = [
  { name: "read the queue", method: "GET", path: (id: string) => `/v1/queue/${id}?ref=${encodeURIComponent(REF)}` },
  {
    name: "explain the queue",
    method: "GET",
    path: (id: string) => `/v1/queue/${id}/explain?ref=${encodeURIComponent(REF)}`,
  },
  {
    name: "join the queue",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/entries?ref=${encodeURIComponent(REF)}`,
    body: { pullRequestNumber: 7, headSha: "a".repeat(40) },
  },
  {
    name: "cancel an entry",
    method: "DELETE",
    path: (id: string) => `/v1/queue/${id}/entries/entry_${id}_7?ref=${encodeURIComponent(REF)}`,
  },
  { name: "tick the scheduler", method: "POST", path: (id: string) => `/v1/queue/${id}/tick?ref=${encodeURIComponent(REF)}` },
  { name: "nudge the lane", method: "POST", path: (id: string) => `/v1/queue/${id}/nudge?ref=${encodeURIComponent(REF)}` },
  {
    name: "heartbeat a runner",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/runners/heartbeat`,
    body: { deviceKeyId: DEVICE },
  },
  {
    name: "read a candidate verdict",
    method: "GET",
    path: (id: string) => `/v1/queue/${id}/candidate?ref=${encodeURIComponent(REF)}&tree=${"7".repeat(40)}`,
  },
] as const;

/** The same, for the routes that additionally want an administrator. */
const ADMIN_ROUTES = [
  {
    name: "pause the queue",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/pause?ref=${encodeURIComponent(REF)}`,
    body: { reason: "the base moved" },
  },
  { name: "resume the queue", method: "POST", path: (id: string) => `/v1/queue/${id}/resume?ref=${encodeURIComponent(REF)}` },
  {
    name: "rebaseline the queue",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/rebaseline?ref=${encodeURIComponent(REF)}`,
    body: { baseSha: "b".repeat(40) },
  },
  {
    name: "adopt a chain",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/adopt-chain?ref=${encodeURIComponent(REF)}`,
  },
  {
    name: "reconcile a held attempt",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/reconcile?ref=${encodeURIComponent(REF)}`,
    body: { observed: "not-merged", reason: "looked at the pull request" },
  },
  {
    name: "repair a merge that was never recorded",
    method: "POST",
    path: (id: string) => `/v1/queue/${id}/repair?ref=${encodeURIComponent(REF)}`,
    body: { mergeSha: "c".repeat(40), reason: "the merge is on main with no record" },
  },
] as const;

type Route = { name: string; method: string; path: (id: string) => string; body?: Record<string, unknown> };

function call(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  route: Route,
  repositoryId = VICTIM_REPO,
): Promise<Response> {
  return app.request(
    route.path(repositoryId),
    route.body === undefined
      ? { method: route.method }
      : {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(route.body),
        },
    e,
  );
}

async function refusal(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? "";
}

describe("a principal of another organization", () => {
  for (const route of [...MEMBER_ROUTES, ...ADMIN_ROUTES] as readonly Route[]) {
    it(`may not ${route.name}`, async () => {
      const e = env();
      seed();

      const response = await call(routes(BRAVO), e, route);

      expect(response.status).toBe(403);
      expect(await refusal(response)).toBe(REPOSITORY_FORBIDDEN);
      expect(dispatched).toEqual([]);
    });
  }

  /**
   * A refusal must not become a second way to enumerate. A repository nobody
   * has onboarded and a repository this caller is simply not in are the same
   * answer, byte for byte, or the difference is the enumeration itself.
   */
  it("gets the same answer for a repository that does not exist", async () => {
    const e = env();
    seed();
    const app = routes(BRAVO);

    const absent = await call(app, e, MEMBER_ROUTES[0] as Route, ABSENT_REPO);
    const priv = await call(app, e, MEMBER_ROUTES[0] as Route, VICTIM_REPO);

    expect(absent.status).toBe(priv.status);
    expect(await absent.text()).toBe(await priv.text());
  });
});

/**
 * `authenticate` answers for whichever organization the session selected, so
 * `isAdmin` is a claim about that organization and never about the repository
 * in the path. Read before membership, it said an administrator of Bravo was
 * an administrator of Acme, and Bravo's owner could pause, rebaseline and
 * reconcile Acme's queue.
 */
describe("an administrator of another organization", () => {
  for (const route of ADMIN_ROUTES as readonly Route[]) {
    it(`is not an administrator here, so may not ${route.name}`, async () => {
      const e = env();
      seed();

      const response = await call(routes({ ...BRAVO, isAdmin: true }), e, route);

      expect(response.status).toBe(403);
      // Membership, not the admin refusal: being an administrator somewhere
      // else is not a weaker version of belonging here.
      expect(await refusal(response)).toBe(REPOSITORY_FORBIDDEN);
    });
  }
});

describe("a principal of the organization that owns the repository", () => {
  for (const route of MEMBER_ROUTES as readonly Route[]) {
    it(`may ${route.name}`, async () => {
      const e = env();
      seed();

      const response = await call(routes(ACME), e, route);

      expect(await refusal(response)).not.toBe(REPOSITORY_FORBIDDEN);
      expect(response.status).not.toBe(403);
    });
  }

  for (const route of ADMIN_ROUTES as readonly Route[]) {
    it(`reaches the administrator check to ${route.name}`, async () => {
      const e = env();
      seed();

      const response = await call(routes(ACME), e, route);

      expect(response.status).toBe(403);
      expect(await refusal(response)).toBe("repository admin required");
    });
  }

  for (const route of ADMIN_ROUTES as readonly Route[]) {
    it(`may ${route.name} as an administrator of that organization`, async () => {
      const e = env();
      seed();

      const response = await call(routes({ ...ACME, isAdmin: true }), e, route);

      const error = await refusal(response);
      expect(error).not.toBe(REPOSITORY_FORBIDDEN);
      expect(error).not.toBe("repository admin required");
    });
  }
});

describe("a caller with no session at all", () => {
  for (const route of [...MEMBER_ROUTES, ...ADMIN_ROUTES] as readonly Route[]) {
    it(`may not ${route.name}`, async () => {
      const e = env();
      seed();

      const response = await call(routes(null), e, route);

      expect(response.status).toBe(401);
      expect(dispatched).toEqual([]);
    });
  }
});

/**
 * The routes a pinned workflow calls prove more than membership: a GitHub
 * Actions OIDC token names the repository it was minted in, and each of these
 * refuses one minted for another. Gating them on a principal's membership as
 * well would refuse the workflow, which holds no session and belongs to no
 * organization, so the gate has to leave them alone.
 */
describe("the repository's own workflows", () => {
  const WORKFLOW_ROUTES: readonly Route[] = [
    {
      name: "authorize a merge",
      method: "POST",
      path: (id: string) => `/v1/queue/${id}/authorize`,
      body: { pullRequestNumber: 7, headSha: "a".repeat(40), baseRef: REF, authorGithubUserId: "11" },
    },
    {
      name: "report a candidate result",
      method: "POST",
      path: (id: string) => `/v1/queue/${id}/candidate-result`,
      body: { baseRef: REF },
    },
    {
      name: "report a merge",
      method: "POST",
      path: (id: string) => `/v1/queue/${id}/merged`,
      body: { baseRef: REF },
    },
    {
      name: "report that a merge did not happen",
      method: "POST",
      path: (id: string) => `/v1/queue/${id}/not-merged`,
      body: { baseRef: REF },
    },
  ];

  for (const route of WORKFLOW_ROUTES) {
    it(`may still ${route.name} with no session`, async () => {
      const e = env();
      seed();
      const app = routes(null, async () => ({ repository_id: VICTIM_REPO }));

      const response = await call(app, e, route);

      expect(response.status).not.toBe(401);
      expect(await refusal(response)).not.toBe(REPOSITORY_FORBIDDEN);
    });
  }

  /**
   * The merge workflow polls the candidate endpoint with the same token it
   * authorizes with. Requiring a session there sent it a 401 on every poll.
   */
  it("reads a candidate verdict with a workflow token and no session", async () => {
    const e = env();
    seed();
    const app = routes(null, async () => ({ repository_id: VICTIM_REPO }));

    const response = await app.request(
      `/v1/queue/${VICTIM_REPO}/candidate?ref=${encodeURIComponent(REF)}&tree=${"7".repeat(40)}`,
      {},
      e,
    );

    expect(response.status).toBe(200);
  });

  /** A token minted in another repository is not a way in. */
  it("refuses a workflow token minted for another repository", async () => {
    const e = env();
    seed();
    const app = routes(null, async () => ({ repository_id: ABSENT_REPO }));

    const response = await app.request(
      `/v1/queue/${VICTIM_REPO}/candidate?ref=${encodeURIComponent(REF)}&tree=${"7".repeat(40)}`,
      {},
      e,
    );

    expect(response.status).toBe(401);
  });
});
