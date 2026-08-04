import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import type { QueueRouteEnv } from "./routes.js";
import { loadQueueState } from "./queue-state.js";
import { runOnQueue } from "./routes.js";
import type { D1Like } from "./projection.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));
const { queueFromPullRequest } = await import("../index.js");
const { reconsiderHead } = await import("./reconsider-head.js");
const { processQueueMessage } = await import("../queue-consumer.js");

/**
 * A pull request reaching the lane on GitHub's own delivery, and nothing else.
 *
 * The webhook used to enqueue and stop. It called `requestTurn` and
 * `evaluateReadiness` and never `admit`, so the scheduler was not ticked, no
 * offer was made, and no lane was driven. Everything past enqueuing lived in
 * `/authorize`, which only a workflow holding an Actions OIDC token could
 * reach — so a repository with no workflow files enqueued pull requests and
 * merged none of them.
 *
 * The delivery is HMAC-verified by GitHub's own signature over a payload the
 * branch under test cannot author, and every fact the walk rests on is read
 * with the App's installation token. Nothing here takes a claim from CI.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "5".repeat(40);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "acme", "9001");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, 1, 'enforced')",
    )
    .run("qp_1", "org_1", REPO, REF);
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "alice");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

function opened(action = "opened", headSha = HEAD) {
  return {
    action,
    pull_request: {
      number: 120,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: headSha },
      user: { id: 1, login: "alice", type: "User" },
    },
  };
}

/** The same transaction the routes use, without a turn check to publish. */
const onQueue = ((env, repositoryId, baseRef, decide) =>
  runOnQueue(env, repositoryId, baseRef, decide)) as Parameters<typeof reconsiderHead>[2];

async function entry(e: QueueRouteEnv) {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return store.state().entries.get(`entry_${REPO}_120`);
}

/** The queue's own reads, with GitHub stubbed to one open pull request on HEAD. */
function reads(over: Record<string, unknown> = {}) {
  return {
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" as const }),
    principalFor: async () => "alice",
    pullRequestPlacement: async () => ({
      authorGithubUserId: "1",
      baseRef: REF,
      authorIsBot: false,
      draft: false,
      headSha: HEAD,
    }),
    pullRequestNumbersForCommit: async () => [120],
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: [] }),
    proofCheckRunId: async () => null,
    baseContainsSha: async () => true,
    signRecordBytes: async () => "jws",
    queueProjectForRecord: async () => ({ mergeMethod: "merge" as const }),
    ...over,
  };
}

describe("enrolment from the pull_request webhook", () => {
  it("offers the lane to a pull request whose proof the App accepted", async () => {
    const e = env();
    acceptProof(raw, REPO, HEAD);

    const result = await queueFromPullRequest(e as never, opened());

    expect(result.handled).toBe(true);
    // Offered and claimed in one walk: under a profile with no device to wait
    // for, the server takes the turn it just offered itself.
    expect((await entry(e))?.state).toBe("Active");
  });

  it("leaves a pull request waiting when the App has verified nothing", async () => {
    const e = env();

    await queueFromPullRequest(e as never, opened());

    const placed = await entry(e);
    expect(placed?.state).toBe("Blocked");
    expect(placed?.primaryReason).toBe("LOCAL_RECEIPT_MISSING");
  });

  it("takes the turn the moment the verdict lands, not at the next minute", async () => {
    const e = env();
    await queueFromPullRequest(e as never, opened());
    expect((await entry(e))?.state).toBe("Blocked");

    // Same second, so the readiness bucket has not moved. A key that only
    // named the minute dropped this as a repeat and the pull request stayed
    // blocked on a proof that had passed.
    acceptProof(raw, REPO, HEAD);
    await queueFromPullRequest(e as never, opened("synchronize"));

    expect((await entry(e))?.state).toBe("Active");
  });

  it("takes the turn when the App's own verdict lands, with no further delivery", async () => {
    const e = env();
    await queueFromPullRequest(e as never, opened());
    expect((await entry(e))?.state).toBe("Blocked");

    // What the consumer does after `processAppProof` stores the verdict. No
    // pull request event happens between the two, so this is the only thing
    // that can move the entry.
    acceptProof(raw, REPO, HEAD);
    const walked = await reconsiderHead(e, reads() as never, onQueue, { repositoryId: REPO, headSha: HEAD });

    expect(walked).toBe(1);
    expect((await entry(e))?.state).toBe("Active");
  });

  it("is what the consumer does once a proof verification finishes", async () => {
    const seen: Array<[string, string]> = [];
    await processQueueMessage(
      { appProofTask: { kind: "verify", request: { event: "pull_request", repositoryId: REPO, subjectSha: HEAD } as never } },
      new Set(),
      { reconsiderHead: async (repositoryId, headSha) => void seen.push([repositoryId, headSha]) },
    );
    expect(seen).toEqual([[REPO, HEAD]]);
  });

  it("leaves a merge-group subject alone, because no pull request is on it", async () => {
    const seen: string[] = [];
    await processQueueMessage(
      { appProofTask: { kind: "verify", request: { event: "merge_group", repositoryId: REPO, subjectSha: HEAD } as never } },
      new Set(),
      { reconsiderHead: async (_r, headSha) => void seen.push(headSha) },
    );
    expect(seen).toEqual([]);
  });

  it("walks nothing for a commit that is not the head of the pull request it appears in", async () => {
    const e = env();
    acceptProof(raw, REPO, HEAD);
    const walked = await reconsiderHead(
      e,
      reads({ pullRequestPlacement: async () => ({
        authorGithubUserId: "1",
        baseRef: REF,
        authorIsBot: false,
        draft: false,
        headSha: "9".repeat(40),
      }) }) as never,
      onQueue,
      { repositoryId: REPO, headSha: HEAD },
    );
    expect(walked).toBe(0);
  });

  it("walks nothing when GitHub could not say which pull requests a commit is on", async () => {
    const e = env();
    acceptProof(raw, REPO, HEAD);
    const walked = await reconsiderHead(
      e,
      reads({ pullRequestNumbersForCommit: async () => null }) as never,
      onQueue,
      { repositoryId: REPO, headSha: HEAD },
    );
    expect(walked).toBe(0);
  });
});
