import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Nothing in this file is about GitHub, and until now every run of it called
 * api.github.com for real: the walk publishes a check and a status comment, and
 * both went out over the network to be told 401. That is somebody else's uptime
 * deciding whether this suite passes, and it started failing two of these under
 * load. GitHub answers nothing here.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/check-runs") ? Response.json({ check_runs: [] }) : Response.json([]),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

function opened(action = "opened", headSha = HEAD, draft = false) {
  return {
    action,
    pull_request: {
      number: 120,
      draft,
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

async function attempt(e: QueueRouteEnv, attemptId: string) {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return store.state().attempts.get(attemptId);
}

/** The id of the attempt holding the lane, which the walk above just claimed. */
async function activeAttempt(e: QueueRouteEnv): Promise<string> {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  const attemptId = store.state().activeAttemptId;
  if (attemptId === null) throw new Error("no attempt holds the lane");
  return attemptId;
}

/** Take the running attempt into its grace window, the way a dead device does. */
async function loseTheHeartbeat(e: QueueRouteEnv): Promise<string> {
  const attemptId = await activeAttempt(e);
  await runOnQueue(e, REPO, REF, ({ commands }) => {
    commands.candidatePrepared({
      idempotencyKey: "prepared",
      attemptId,
      baseSha: "b".repeat(40),
      headSha: HEAD,
      candidateSha: "c".repeat(40),
      candidateTree: "t".repeat(40),
      policyDigest: "sha256:pol",
      runner: "dagger",
    });
    commands.assign({ idempotencyKey: "assign", attemptId, assignmentDigest: "sha256:asg" });
    commands.heartbeat({ idempotencyKey: "beat", attemptId });
    commands.heartbeatLost({ idempotencyKey: "lost", attemptId });
  });
  return attemptId;
}

/** Walk the attempt to a merge write whose outcome nobody knows. */
async function reachReconciling(e: QueueRouteEnv): Promise<string> {
  const attemptId = await activeAttempt(e);
  await runOnQueue(e, REPO, REF, ({ commands }) => {
    commands.candidatePrepared({
      idempotencyKey: "prepared",
      attemptId,
      baseSha: "b".repeat(40),
      headSha: HEAD,
      candidateSha: "c".repeat(40),
      candidateTree: "t".repeat(40),
      policyDigest: "sha256:pol",
      runner: "dagger",
    });
    commands.assign({ idempotencyKey: "assign", attemptId, assignmentDigest: "sha256:asg" });
    commands.heartbeat({ idempotencyKey: "beat", attemptId });
    commands.submitReceipt({ idempotencyKey: "receipt", attemptId, receiptDigest: "sha256:rcpt" });
    const started = commands.startVerification({ idempotencyKey: "verify", attemptId }) as { nonce: string };
    commands.completeVerification({
      idempotencyKey: "verified",
      attemptId,
      nonce: started.nonce,
      accepted: true,
      resultDigest: "sha256:res",
    });
    commands.createMergeIntent({ idempotencyKey: "intent", attemptId, intentDigest: "sha256:intent" });
    commands.beginMergeWrite({ idempotencyKey: "write", attemptId, operationId: "op-x" });
    commands.mergeOutcomeUnknown({ idempotencyKey: "unknown", attemptId });
  });
  return attemptId;
}

/** The queue's own reads, with GitHub stubbed to one open pull request on HEAD. */
function reads(over: Record<string, unknown> = {}) {
  return {
    queueProject: async () => ({ activationState: "enforced" }),
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
    commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: [] }),
    proofCheckRunId: async () => null,
    baseContainsSha: async () => true,
    signRecordBytes: async () => "jws",
    ...over,
  };
}

describe("enrolment from the pull_request webhook", () => {
  it("does not place a draft; marking it ready places it", async () => {
    const e = env();

    await queueFromPullRequest(e as never, opened("opened", HEAD, true));
    expect(await entry(e)).toBeUndefined();

    await queueFromPullRequest(e as never, opened("ready_for_review", HEAD));
    expect(await entry(e)).not.toBeUndefined();
  });

  it("withdraws an entry left by a draft, and re-admits it when marked ready", async () => {
    const e = env();
    // An entry that predates the draft rule (or a pull request marked draft
    // after joining) holds a blocked place in the waiting list. A draft
    // arrival withdraws it, and `ready_for_review` puts it back at the back.
    await queueFromPullRequest(e as never, opened("opened", HEAD));
    expect(await entry(e)).not.toBeUndefined();

    await queueFromPullRequest(e as never, opened("converted_to_draft", HEAD, true));
    expect((await entry(e))?.state).toBe("Cancelled");
    // Why it left, recorded on the entry, because the status comment is the
    // only surface that tells the author anything and "this entry left the
    // queue" tells them nothing they can act on.
    expect((await entry(e))?.primaryReason).toBe("PR_DRAFT");

    // A changed decision re-evaluates even inside the same readiness bucket,
    // so the re-requested entry takes the lane again once the proof lands.
    acceptProof(raw, REPO, HEAD);
    await queueFromPullRequest(e as never, opened("ready_for_review", HEAD));
    expect((await entry(e))?.state).toBe("Active");
  });

  /**
   * Toggling draft twice without pushing repeats every other part of the
   * withdrawal's key, so keying it on the head made the second withdrawal a
   * duplicate and left the entry holding a place it had given up.
   */
  it("withdraws a second time when the same head is drafted, readied, and drafted again", async () => {
    const e = env();
    await queueFromPullRequest(e as never, opened("opened", HEAD));
    await queueFromPullRequest(e as never, opened("converted_to_draft", HEAD, true));
    expect((await entry(e))?.state).toBe("Cancelled");

    // Re-admitted without a proof, so it waits rather than taking the lane.
    // A draft that already holds the lane is left alone on purpose, and that
    // exemption would otherwise hide the repeat this test is about.
    await queueFromPullRequest(e as never, opened("ready_for_review", HEAD));
    expect((await entry(e))?.state).not.toBe("Cancelled");

    await queueFromPullRequest(e as never, opened("converted_to_draft", HEAD, true));
    expect((await entry(e))?.state).toBe("Cancelled");
  });

  /**
   * The two states with a live attempt that the state list forgot.
   *
   * The guard asked `HOLDING`, a list written for `driveQueue`'s narrower
   * question: which entry is the lane, for the purpose of advancing a merge
   * write. That is not the same question as "is there a run in flight", and two
   * states answer them differently. In `ReconnectGrace` a run has lost its
   * heartbeats and is inside its grace window, and cancelling killed it. In
   * `Reconciling` a merge write is out with its outcome unknown, and the
   * reducer refuses the cancel — correctly, and the webhook told the author it
   * had withdrawn anyway.
   */
  it("leaves a draft alone while its attempt is inside the reconnect grace", async () => {
    const e = env();
    acceptProof(raw, REPO, HEAD);
    await queueFromPullRequest(e as never, opened("opened", HEAD));
    const attemptId = await loseTheHeartbeat(e);
    expect((await entry(e))?.state).toBe("ReconnectGrace");

    const result = await queueFromPullRequest(e as never, opened("converted_to_draft", HEAD, true));

    expect((await entry(e))?.state).toBe("ReconnectGrace");
    expect((await attempt(e, attemptId))?.outcome).toBeNull();
    expect(result.detail).not.toContain("withdrawn");
  });

  it("never says withdrawn about an entry it did not withdraw", async () => {
    const e = env();
    acceptProof(raw, REPO, HEAD);
    await queueFromPullRequest(e as never, opened("opened", HEAD));
    await reachReconciling(e);
    expect((await entry(e))?.state).toBe("Reconciling");

    const result = await queueFromPullRequest(e as never, opened("converted_to_draft", HEAD, true));

    expect((await entry(e))?.state).toBe("Reconciling");
    expect(result.detail).not.toContain("withdrawn");
  });

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
      { appProofTask: { kind: "verify", request: { repositoryId: REPO, subjectSha: HEAD } as never } },
      new Set(),
      { reconsiderHead: async (repositoryId, headSha) => void seen.push([repositoryId, headSha]) },
    );
    expect(seen).toEqual([[REPO, HEAD]]);
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
