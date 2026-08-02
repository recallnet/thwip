import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { unsatisfiedRequiredChecks } from "./github-port.js";
import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";

/**
 * The merge the queue can tell will be refused, before it asks for it.
 *
 * A branch ruleset requires two checks. When one of them is not on the head,
 * GitHub answers the merge PUT with 405 and the queue found that out from the
 * rejection: it had already given the entry a turn, signed a merge intent and
 * minted an operation, and the attempt sat holding the lane while everything
 * behind it stopped. That happened repeatedly on recallnet/thwip in one day, and
 * clearing it took a person each time.
 *
 * Both facts are readable first. The branch rules name the contexts and the head
 * carries the runs, so a merge that cannot succeed is refused with a sentence
 * naming the missing check rather than discovered from GitHub's answer.
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

describe("what the branch requires, read before the merge is asked for", () => {
  it("refuses the merge and names the check nothing has published", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [PROOF_CHECK, TURN_CHECK],
        // The shape observed on pull requests 114 and 120: the workflow's proof
        // check landed and the App's turn check never did.
        runs: [{ name: PROOF_CHECK, status: "completed", conclusion: "success" }],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.operationId).toBeNull();
    expect(verdict.reason).toBe("REQUIRED_CHECK_MISSING");
    expect(verdict.detail).toContain(TURN_CHECK);
  });

  it("prepares the merge when every required check is on the head", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [PROOF_CHECK, TURN_CHECK],
        runs: [
          { name: PROOF_CHECK, status: "completed", conclusion: "success" },
          { name: TURN_CHECK, status: "completed", conclusion: "success" },
        ],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("HOLDS_TURN");
    expect(verdict.operationId).not.toBeNull();
  });

  it("prepares the merge when the branch rules cannot be read, because unknown is not a refusal", async () => {
    const e = env();
    const app = routes({ requiredCheckState: async () => null });

    const verdict = await prepareMerge(app, e);

    expect(verdict.operationId).not.toBeNull();
  });
});

describe("which required checks a head certainly fails", () => {
  it("names one nothing published and one that concluded badly", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: ["thwip", TURN_CHECK, "lint"],
        runs: [
          { name: "thwip", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "failure" },
        ],
      }),
    ).toEqual([
      { context: TURN_CHECK, state: "absent" },
      { context: "lint", state: "failed" },
    ]);
  });

  it("leaves a check that is still running alone, because it may yet pass", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: [TURN_CHECK],
        runs: [{ name: TURN_CHECK, status: "in_progress", conclusion: null }],
      }),
    ).toEqual([]);
  });

  it("counts neutral and skipped as satisfied, the way GitHub does", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: ["neutral-suite", "skipped-suite"],
        runs: [
          { name: "neutral-suite", status: "completed", conclusion: "neutral" },
          { name: "skipped-suite", status: "completed", conclusion: "skipped" },
        ],
      }),
    ).toEqual([]);
  });
});
