import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * The repository the queue's policy assumes, read before the merge is asked for.
 *
 * Three reason codes describe a repository that has moved out from under the
 * queue: the branch ruleset no longer enforces what the queue was set up to
 * enforce, the App installation has lost a permission the product needs, and the
 * person whose turn this is no longer holds the repository permission. All three
 * have sentences on the check, in the terminal and on the dashboard, and all
 * three come out of `deriveReadiness`, which nothing called. `/authorize` and the
 * pull-request webhook each derived a narrower readiness by hand, so a merge
 * could be authorized against a repository none of the three still described.
 *
 * They are read at the point they matter, which is the walk to a merge, not on
 * every ask. A pull request waiting behind four others polls this route once a
 * minute and must not spend three GitHub reads doing it.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
const PROVEN =
  "feat: something\n\nthwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlmUT09Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6ayIsInNpZyI6IkFBQUEifV19\n";

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "author1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const HEALTHY = { rulesetEnforced: true, appPermissionsHealthy: true, sponsorAuthorized: true };

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    publishTurnCheck: async () => {},
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => ({
      policyDigest: `sha256:${"b".repeat(64)}`,
      pipelineDigest: `sha256:${"c".repeat(64)}`,
      requiredSuites: ["unit"],
      securityProfile: "fast",
      organizationId: "org_1",
      verifier: null,
    }),
    proofCheckRunId: async () => "778899",
    signRecordBytes: async (_e, bytes) => `jws.${bytes.byteLength}`,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async (_e, githubUserId) => `principal_${githubUserId}`,
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF }),
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: TREE, parentShas: ["b".repeat(40), "6".repeat(40)], message: PROVEN }),
    sleep: async () => {},
    ...over,
  });
}

interface Verdict {
  authorized: boolean;
  reason: string;
  detail?: string;
  operationId: string | null;
}

async function prepareMerge(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<Verdict> {
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: 120,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        proofAccepted: true,
        draft: false,
        prepare: true,
        candidate: {
          baseSha: "b".repeat(40),
          candidateSha: "c".repeat(40),
          candidateTreeOid: TREE,
          parentShas: ["b".repeat(40), "6".repeat(40)],
        },
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

describe("the repository the policy assumes, read before the merge is asked for", () => {
  it("refuses a merge on a branch whose ruleset has drifted", async () => {
    const e = env();
    const app = routes({ platformHealth: async () => ({ ...HEALTHY, rulesetEnforced: false }) });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.operationId).toBeNull();
    expect(verdict.reason).toBe("RULESET_DRIFT");
  });

  it("refuses a merge when the App installation has lost a permission", async () => {
    const e = env();
    const app = routes({ platformHealth: async () => ({ ...HEALTHY, appPermissionsHealthy: false }) });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.operationId).toBeNull();
    expect(verdict.reason).toBe("APP_PERMISSION_DRIFT");
  });

  it("refuses a merge when the signer's repository permission has been revoked", async () => {
    const e = env();
    const app = routes({ platformHealth: async () => ({ ...HEALTHY, sponsorAuthorized: false }) });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.operationId).toBeNull();
    // `PERMISSION_REVOKED` is the attempt outcome; `OWNER_UNAUTHORIZED` is what a
    // reader is told, and the reducer already maps one to the other.
    expect(verdict.reason).toBe("OWNER_UNAUTHORIZED");
  });

  it("names the most actionable problem when more than one holds", async () => {
    const e = env();
    const app = routes({
      platformHealth: async () => ({ rulesetEnforced: false, appPermissionsHealthy: false, sponsorAuthorized: false }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("OWNER_UNAUTHORIZED");
  });

  it("prepares the merge when all three still hold", async () => {
    const e = env();
    const app = routes({ platformHealth: async () => HEALTHY });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("HOLDS_TURN");
    expect(verdict.operationId).not.toBeNull();
  });

  it("prepares the merge when GitHub could not be read, because unknown is not a refusal", async () => {
    const e = env();
    const app = routes({ platformHealth: async () => null });

    const verdict = await prepareMerge(app, e);

    expect(verdict.operationId).not.toBeNull();
  });

  it("does not read GitHub for a pull request that is only asking whose turn it is", async () => {
    const e = env();
    let reads = 0;
    const app = routes({
      platformHealth: async () => {
        reads += 1;
        return HEALTHY;
      },
    });

    const response = await app.request(
      `/v1/queue/${REPO}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pullRequestNumber: 121,
          headSha: HEAD,
          baseRef: REF,
          authorGithubUserId: "1",
          proofAccepted: true,
          draft: false,
        }),
      },
      e,
    );

    expect(response.status).toBe(200);
    expect(reads).toBe(0);
  });
});
