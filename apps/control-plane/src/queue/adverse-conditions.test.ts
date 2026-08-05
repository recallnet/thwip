import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { TurnCheckUpdate } from "./turn-check.js";
import { externalPushFromWebhook, QUEUE_MERGE_TRAILER } from "./external-push.js";
import { b64stdEncode, encodeCarrier, utf8Encode } from "@thwip/protocol";
import type { Env } from "../env.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool. Stubbing that
// one export lets `queueFromPullRequest` load under plain node, the same way
// every other control-plane unit test avoids the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
// The webhook path signs a real GitHub App JWT before it reaches `fetch`.
// Stubbing the installation token keeps these queue tests independent of a
// production private key.
vi.mock("../github-app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app.js")>();
  return { ...actual, installationToken: async () => "test-installation-token" };
});
const { queueFromPullRequest } = await import("../index.js");

/**
 * The queue under the conditions that actually broke it.
 *
 * Every case here is something that happened to a live repository rather than
 * something imagined: a pull request closed while it held the lane, a merge
 * GitHub refused, a base branch that moved underneath a turn, and several checks
 * arriving at once. Each cost hours to diagnose, and none of them could be
 * written as a test while the queue lived in a Durable Object.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  // Every session-authenticated queue route establishes membership before it
  // acts, so the session this file's `routes()` stub holds has to belong to the
  // organization that owns the repository or nothing here reaches its subject.
  seedMembership("alice", "1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
// A real object id: the signed records refuse anything that is not one.
const TREE = "7".repeat(40);

/**
 * A commit message carrying a readable proof, as a shipped head does.
 *
 * The payload is a real predicate rather than an empty statement, because the
 * merge gate reads what the proof bound: the policy and pipeline it satisfied,
 * and the suites it ran. Defaults match the policy `routes()` stubs.
 */
function provenCommit(
  over: {
    policyDigest?: string;
    pipelineDigest?: string;
    suites?: Array<{ id: string; status: "passed" | "failed" }>;
  } = {},
): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: "urn:thwip:attestation:ci-run:v1",
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "1", repositoryId: REPO },
      git: {
        objectFormat: "sha1",
        treeOid: TREE,
        parentOids: ["b".repeat(40)],
        baseRef: REF,
        baseSha: "b".repeat(40),
        evaluationMode: "head-tree",
      },
      policy: { digest: over.policyDigest ?? `sha256:${"b".repeat(64)}`, version: 1 },
      pipeline: { digest: over.pipelineDigest ?? `sha256:${"c".repeat(64)}`, runner: "command" },
      run: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        networkMode: "disabled",
        cacheMode: "disabled",
        suites: (over.suites ?? [{ id: "unit", status: "passed" as const }]).map((s) => ({
          ...s,
          durationMs: 1,
        })),
      },
      signer: { keyId: `SHA256:${"k".repeat(43)}`, githubUserId: "1" },
    },
  };
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: b64stdEncode(utf8Encode(JSON.stringify(statement))),
    signatures: [{ keyid: `SHA256:${"k".repeat(43)}`, sig: "AAAA" }],
  };
  return `feat: something\n\n${encodeCarrier(envelope as never)}\n`;
}

const PROVEN = provenCommit();

const published: TurnCheckUpdate[] = [];

/**
 * The commits GitHub holds, for the routes that read one.
 *
 * A merge report names a commit and says nothing else about it: the tree and
 * the parents come from GitHub. So a test that reports a merge says here what
 * GitHub answers for that commit. Every other sha is a pull request head, and
 * the default below describes those as carrying a proof.
 */
const commits = new Map<string, { treeOid: string; parentShas: string[] }>();

/** What GitHub holds for the commit a test is about to report as merged. */
function landed(sha: string, treeOid: string, parentShas: readonly string[]): void {
  commits.set(sha, { treeOid, parentShas: [...parentShas] });
}

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  published.length = 0;
  commits.clear();
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, treeOid: TREE }, {
      publishTurnCheck: async (_e: unknown, _r: string, update: never) => {
        published.push(update);
      },
      commitFacts: async (_e: unknown, _r: string, sha: string) =>
        commits.get(sha) ?? { treeOid: TREE, parentShas: ["b".repeat(40), "6".repeat(40)], message: PROVEN },
      // A refusal the queue can confirm: GitHub says not merged and the base does
      // not contain the head. Every test that reports a refusal means this one,
      // and the tests that mean a stale read say so themselves.
      pullRequestMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      // Two questions reach this. The head has not landed, which is the refusal
      // above; the commit a test reports as merged has, which is what lets its
      // record be signed. Head shas here are a pull request number padded with
      // "a" and no test reports one as its merge, so the prefix separates them.
      baseContainsSha: async (_e: unknown, _r: string, _ref: string, sha: string) => !sha.startsWith("a"),
      // Most cases in this file exercise queue state rather than merge
      // evidence. With no active policy the route's internal App wake cannot
      // sign a merge intent, so it leaves the lane available for those tests.
      activePolicy: async () => null,
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

interface Verdict {
  authorized: boolean;
  reason: string;
  entryId: string;
  operationId: string | null;
  merge?: {
    baseRef: string;
    baseSha: string;
    headSha: string;
    treeOid: string;
    parentShas: string[];
  } | null;
}

type App = ReturnType<typeof routes>;

async function authorize(app: App, e: QueueRouteEnv, pr: number, over: Record<string, unknown> = {}) {
  acceptProof(raw, REPO, (over["headSha"] as string | undefined) ?? String(pr).padStart(40, "a"));
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: pr,
        headSha: String(pr).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pr),
        draft: false,
        ...over,
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

/** A device id shaped the way `thwip queue work` sends one: a signing key fingerprint. */
const DEVICE = `SHA256:${"a".repeat(43)}`;

/** The repository's organization, its project row, and one principal in it. */
function seedMembership(principalId: string, githubUserId: string): void {
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
    .run(principalId, "org_1", githubUserId, `author${githubUserId}`);
}

/**
 * Post a heartbeat as `principalId`, the way a connected device does before a
 * device-only entry can ever become scheduler-eligible. `routes()`'s own
 * `authenticate` stub is fixed to "alice", so callers that need a different
 * connected principal — `principalFor` maps a pull request's author to
 * `principal_<githubUserId>`, not to the session's principal — must build
 * their own app with `authenticate` overridden to match.
 *
 * The route also refuses a principal who is not in the organization that owns
 * the repository, so a test that heartbeats calls `seedMembership` first.
 */
async function heartbeat(app: App, e: QueueRouteEnv, deviceKeyId = DEVICE) {
  return app.request(
    `/v1/queue/${REPO}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId }) },
    e,
  );
}

async function liveState(app: App, e: QueueRouteEnv) {
  const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
  return (await response.json()) as {
    activeAttemptId: string | null;
    paused: boolean;
    rebaselineRequired: boolean;
    entries: Array<{ pullRequestNumber: number; state: string; headSha: string | null }>;
  };
}

function stateOf(snapshot: Awaited<ReturnType<typeof liveState>>, pr: number) {
  return snapshot.entries.find((entry) => entry.pullRequestNumber === pr)?.state;
}

describe("several pull requests arriving at once", () => {
  it("gives the lane to exactly one, however they interleave", async () => {
    const e = env();
    const app = routes();

    // Genuinely concurrent, which is what a repository with several open pull
    // requests does every time somebody pushes.
    const verdicts = await Promise.all([59, 61, 65, 66, 67].map((pr) => authorize(app, e, pr)));

    expect(verdicts.filter((v) => v.reason === "HOLDS_TURN")).toHaveLength(1);
    expect((await liveState(app, e)).entries.filter((entry) => entry.state === "Active")).toHaveLength(1);
  });

  it("keeps giving one lane no matter how many rounds they ask for", async () => {
    const e = env();
    const app = routes();
    for (let round = 0; round < 4; round += 1) {
      await Promise.all([59, 61, 65].map((pr) => authorize(app, e, pr)));
      const snapshot = await liveState(app, e);
      const holding = snapshot.entries.filter((entry) =>
        ["Offered", "Active", "Verifying", "MergeGuard", "Merging"].includes(entry.state),
      );
      expect(holding, `round ${round}`).toHaveLength(1);
    }
  });
});

describe("the pull request holding the lane goes away", () => {
  /**
   * A closed pull request is never coming back to take its turn, so a queue that
   * keeps it holding the lane stops entirely. This happened: the webhook that
   * cancels a closed entry was still writing to storage nothing read, and the
   * lane sat on a pull request that no longer existed.
   */
  it("frees the lane and offers it to somebody who can use it", async () => {
    const e = env();
    const app = routes();
    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    expect(first.reason).toBe("HOLDS_TURN");

    const removed = await app.request(
      `/v1/queue/${REPO}/entries/${first.entryId}?ref=${encodeURIComponent(REF)}&reason=closed`,
      { method: "DELETE" },
      e,
    );
    expect(removed.status).toBe(200);

    expect((await authorize(app, e, 61)).reason).toBe("HOLDS_TURN");
  });
});

/**
 * A pull request that has left must not keep taking turns.
 *
 * Twice in production a merged pull request was still an entry, was offered the
 * turn, and starved the queue behind it until an operator ejected it by hand.
 * The `closed` webhook does cancel an entry, so what matters is the case it was
 * missing: the entry holding a live attempt when its pull request goes away.
 */
describe("a pull request that leaves while holding the lane", () => {
  /**
   * The entry holds the lane and nothing has been sent to GitHub for it. That
   * is the case a close has an answer for. An attempt whose merge write is
   * already in flight is a different question, and the reducer refuses to
   * cancel it: only confirmation may say what a write did.
   */
  it("frees the lane instead of holding it", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    const response = await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}&reason=${encodeURIComponent("the pull request was closed")}`,
      { method: "DELETE" },
      e,
    );
    expect(response.status).toBe(200);

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });
});

/**
 * The actual `closed` webhook, not the DELETE route it drives.
 *
 * Three times in one night a merged pull request — 78, 96 and 97 — stayed an
 * entry, was offered the turn, and starved the queue behind it. The reducer
 * cancels a live attempt fine (see above); what stopped the cancel from
 * reaching it was `queueFromPullRequest` itself. It gated the cancel behind
 * two lookups that exist to decide whether a *new* entry may be placed — a
 * configured project row and the author's activated principal — neither of
 * which a pull request that is only leaving needs. When either lookup came up
 * empty after the entry was already placed, the whole handler returned early
 * and the cancel it should have issued never ran.
 */
describe("the closed webhook itself, once the project or principal it looked up is gone", () => {
  const org = "org_1";
  const authorGithubUserId = "59";

  function seed(raw: import("better-sqlite3").Database) {
    raw
      .prepare(
        "INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)",
      )
      .run(org, "1", "acme");
    raw
      .prepare(
        "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, 1, 'enforced')",
      )
      .run("qp_1", org, REPO, REF);
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run("principal_59", org, authorGithubUserId, "author59");
  }

  function closedPayload() {
    return {
      action: "closed",
      pull_request: {
        number: 59,
        draft: false,
        state: "closed",
        base: { ref: "main", repo: { id: Number(REPO) } },
        head: { sha: String(59).padStart(40, "a") },
        user: { id: 59, login: "author59", type: "User" },
      },
    };
  }

  it("still cancels the entry when the project row has since gone missing", async () => {
    const e = env();
    seed(raw);
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    // The project row that placed this entry is gone by the time it closes —
    // disabled, reconfigured, whatever the reason. The entry it already
    // placed still exists and still needs to leave.
    raw.prepare("DELETE FROM queue_projects WHERE id = 'qp_1'").run();

    const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
    expect(result).toEqual({ handled: true, detail: "entry cancelled" });

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });

  it("still cancels the entry when the author's principal has since gone missing", async () => {
    const e = env();
    seed(raw);
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    // The author's principal that placed this entry is gone by the time it
    // closes. The entry it already placed still exists and still needs to
    // leave; cancelling it never needed to know who the author was.
    raw.prepare("DELETE FROM principals WHERE id = 'principal_59'").run();

    const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
    expect(result).toEqual({ handled: true, detail: "entry cancelled" });

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });

  /**
   * The same family as the eject route and the queue-result callback: freeing
   * the lane is only half of it. `queueFromPullRequest`'s `closed` branch
   * cancels the entry through `commands.cancel` directly, bypassing the
   * App-owned queue driver every route uses, so a pull request closed while it held the
   * lane never told whoever was offered it next.
   */
  it("advances the lane without dispatching repository automation", async () => {
    const e = env();
    seed(raw);
    raw
      .prepare("UPDATE organizations SET installation_id = ? WHERE id = ?")
      .run("inst_1", org);
    raw
      .prepare(
        // Replace: the environment already seeded this project row so the
        // session has a membership to be checked against.
        "INSERT OR REPLACE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run("proj_1", org, REPO, "acme/repo");
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
      expect(result).toEqual({ handled: true, detail: "entry cancelled" });

      const after = await liveState(app, e);
      // The test's GitHub stub cannot describe pull request 61, so the App
      // leaves the newly offered lane untouched rather than guessing.
      expect(stateOf(after, 61)).toBe("Offered");
      const dispatch = fetch.mock.calls.find(([url]) => String(url).includes("/dispatches"));
      expect(dispatch).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  /**
   * The queue driver withholds Actions
   * for `fresh`/`audited`: those profiles have no fallback, so dispatching
   * would spend a run to be told there is nothing for it to do. The `closed`
   * webhook wake once bypassed that check. This proves the fix: a
   * closed pull request still frees a device-only lane, but no longer pays
   * GitHub Actions to find that out.
   */
  it("frees a device-only lane after the closed webhook, without dispatching Actions for it", async () => {
    const e = env();
    seed(raw);
    raw
      .prepare("UPDATE organizations SET installation_id = ? WHERE id = ?")
      .run("inst_1", org);
    raw
      .prepare(
        // Replace: the environment already seeded this project row so the
        // session has a membership to be checked against.
        "INSERT OR REPLACE INTO projects (id, organization_id, github_repository_id, github_name, enabled, active_policy_digest) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run("proj_1", org, REPO, "acme/repo", `sha256:${"d".repeat(64)}`);
    raw
      .prepare(
        "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, ?, 1, ?, 'active')",
      )
      .run(`sha256:${"d".repeat(64)}`, "proj_1", JSON.stringify({ schemaVersion: "1", securityProfile: "fresh", version: 1 }));
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
      expect(result).toEqual({ handled: true, detail: "entry cancelled" });

      // The lane moved to 61 and 61 is offered, but under `fresh` only a
      // connected device ever claims it — dispatching Actions here would be
      // a wasted run.
      const after = await liveState(app, e);
      expect(stateOf(after, 61)).toBe("Offered");
      const dispatch = fetch.mock.calls.find(([url]) => String(url).includes("/dispatches"));
      expect(dispatch).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("ejecting an entry", () => {
  it("advances the App-owned lane after an eject", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 60);

    const response = await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}`,
      { method: "DELETE" },
      e,
    );

    expect(response.status).toBe(200);
    expect(stateOf(await liveState(app, e), 60)).toBe("Active");
  });
});

describe("an operator reconciles a lane that never merged", () => {
  /**
   * Reconciliation ends the held attempt the same way a cancel or a merge
   * does. All three `observed` branches free the lane, so one is enough to
   * prove the route drives the next holder rather than leaving the offer for
   * somebody to notice. `merged-outside-the-turn` needs no prior deadline, so
   * it is the branch that can be reached from a plain held attempt.
   */
  it("advances the App-owned lane after reconciling merged-outside-the-turn", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const response = await app.request(
      `/v1/queue/${REPO}/reconcile?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          observed: "merged-outside-the-turn",
          reason: "operator found it merged by hand",
          mergeSha: "d".repeat(40),
        }),
      },
      e,
    );
    expect(response.status).toBe(200);

    expect(stateOf(await liveState(app, e), 61)).toBe("Active");
  });

  /**
   * Record 121 on this repository's chain, and the three findings it cost.
   *
   * Reconciling used to append a link whose digest was the commit sha padded
   * with zeroes. No record was built, so nothing hashed to it, so the chain
   * route served no link at that position and the next real merge named a
   * predecessor a reader could not fetch. Every tick reported the same
   * BROKEN_LINK, SEQUENCE_GAP and BASE_DISCONTINUITY, and nothing a tick does
   * could ever have cleared them.
   */
  it("writes no chain link for a merge it certifies nothing about", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);

    const response = await app.request(
      `/v1/queue/${REPO}/reconcile?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          observed: "merged-outside-the-turn",
          reason: "operator found it merged by hand",
          mergeSha: "7cf3967bd5751cea12d2f91368b57454b0d6e5ba",
        }),
      },
      e,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { note: string };
    // A reader is told where the record comes from instead of being handed one
    // that does not exist.
    expect(body.note).toMatch(/heal/);

    const links = raw.prepare("SELECT digest FROM queue_transitions_index").all() as Array<{ digest: string }>;
    expect(links).toHaveLength(0);
  });
});

describe("a verifier rejects the candidate", () => {
  /**
   * `queue-result` is the verifier's callback. A rejected verdict terminates
   * the attempt and frees the lane exactly like an eject, a reconcile or a
   * not-merged does, and nothing was telling the next holder about the offer
   * that followed.
   */
  it("advances the App-owned lane after a rejected verdict frees it", async () => {
    const e = env();
    const pinned = {
      repositoryId: REPO,
      repositoryOwnerId: "162603603",
      workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
      workflowSha: null,
      reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify-impl.yml@refs/heads/main",
      reusableWorkflowSha: null,
      expectedEventName: "repository_dispatch" as const,
      defaultBranchRef: "refs/heads/main",
    };
    const claims = {
      repository_id: REPO,
      repository_owner_id: "162603603",
      workflow_ref: pinned.workflowRef,
      workflow_sha: "5".repeat(40),
      job_workflow_ref: pinned.reusableWorkflowRef,
      job_workflow_sha: "6".repeat(40),
      run_id: "998877",
      run_attempt: "1",
      event_name: "repository_dispatch",
      ref: "refs/heads/main",
      jti: "jti-1",
    };
    const app = routes({
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
    });
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const held = await liveState(app, e);
    const attemptId = held.activeAttemptId;
    expect(attemptId).not.toBeNull();

    // Walk the attempt to "verification started" through the domain commands
    // directly. This is the path a real runner takes outside the fast-reuse
    // shortcut `authorize` itself exercises, and it is the only way to reach a
    // live nonce a verifier's callback could plausibly answer.
    const { result: nonce } = await runOnQueue(e, REPO, REF, ({ commands }) => {
      commands.candidatePrepared({
        idempotencyKey: "prep",
        attemptId: attemptId!,
        baseSha: "b".repeat(40),
        headSha: String(59).padStart(40, "a"),
        candidateSha: "c".repeat(40),
        candidateTree: TREE,
        policyDigest: `sha256:${"b".repeat(64)}`,
        runner: "dagger",
      });
      commands.submitReceipt({
        idempotencyKey: "receipt",
        attemptId: attemptId!,
        receiptDigest: `sha256:${"d".repeat(64)}`,
      });
      const started = commands.startVerification({ idempotencyKey: "verify", attemptId: attemptId! });
      return "nonce" in started ? started.nonce : undefined;
    });
    expect(nonce).toBeDefined();

    const response = await app.request(
      "/api/github-actions/queue-result",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId: REPO,
          baseRef: REF,
          attemptId,
          nonce,
          accepted: false,
          resultDigest: `sha256:${"e".repeat(64)}`,
        }),
      },
      e,
    );
    expect(response.status).toBe(202);

    // The rejection blocks 59 and frees the lane; the queue immediately offers
    // it to 61.
    const after = await liveState(app, e);
    expect(stateOf(after, 59)).toBe("Blocked");
    expect(stateOf(after, 61)).toBe("Active");
  });
});

describe("the base branch moves underneath a turn", () => {
  const pushed = (over: Record<string, unknown> = {}) => ({
    ref: REF,
    after: "e".repeat(40),
    deleted: false,
    repository: { id: Number(REPO), default_branch: "main" },
    head_commit: { id: "e".repeat(40), message: "merged by hand, around the queue", ...(over["head_commit"] as object ?? {}) },
    ...over,
  });

  it("is seen for a push the queue did not make", () => {
    expect(externalPushFromWebhook("push", pushed())).toEqual({
      repositoryId: REPO,
      baseRef: REF,
      observedBaseSha: "e".repeat(40),
    });
  });

  it("is not seen for the queue's own merge", () => {
    const own = pushed({
      head_commit: {
        id: "e".repeat(40),
        message: `Merge pull request #1 (Thwip Queue)\n\n${QUEUE_MERGE_TRAILER}: merge_att_1\n`,
      },
    });
    expect(externalPushFromWebhook("push", own)).toBeNull();
  });

  it("stops the queue authorizing anybody once it has been told", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59);
    await authorize(app, e, 61);
    expect(holder.reason).toBe("HOLDS_TURN");

    // What the webhook does with what the detector returned.
    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "the base moved outside the queue" }),
      },
      e,
    );

    expect((await authorize(app, e, 59)).authorized).toBe(false);
    expect((await authorize(app, e, 61)).authorized).toBe(false);
    expect((await liveState(app, e)).paused).toBe(true);
  });

  it("runs again once an operator resumes it", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "looking into something" }),
      },
      e,
    );
    const resumed = await app.request(
      `/v1/queue/${REPO}/resume?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(resumed.status).toBe(200);
    expect((await liveState(app, e)).paused).toBe(false);
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
  });
});

describe("the check that says whose turn it is", () => {
  it("goes green for the holder and stays running for everyone else", async () => {
    const e = env();
    const app = routes();

    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    await authorize(app, e, 65);

    const holder = published.filter((u) => u.state === "holds");
    expect(holder).toHaveLength(1);
    expect(`entry_${REPO}_${holder[0]!.pullRequestNumber}`).toBe(first.entryId);
    // Nobody is told they failed for waiting, which is what used to leave a red
    // check that went on refusing the merge after the queue said yes.
    expect(published.filter((u) => u.state === "waiting").length).toBeGreaterThan(0);
  });

  it("follows the lane when it moves, without a workflow re-run", async () => {
    const e = env();
    const app = routes();
    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await app.request(
      `/v1/queue/${REPO}/entries/${first.entryId}?ref=${encodeURIComponent(REF)}&reason=closed`,
      { method: "DELETE" },
      e,
    );

    // The lane moved to 61 and its check was published by the queue itself.
    expect(published.filter((u) => u.state === "holds").map((u) => u.pullRequestNumber)).toEqual([61]);
  });

  it("tells everyone the queue has halted", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "the base moved outside the queue" }),
      },
      e,
    );

    expect(published.length).toBeGreaterThan(0);
    expect(published.every((u) => u.state === "halted")).toBe(true);
  });

  it("says nothing when nothing moved, rather than one call per entry per ask", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await authorize(app, e, 61);
    await authorize(app, e, 61);
    expect(published).toEqual([]);
  });

  /**
   * This check is required, so a pull request that gets none can never merge and
   * has nothing on the page saying why. The queue publishes a failure instead,
   * because an author with no activated principal is a real problem that will not
   * resolve on its own.
   */
  it("says so when it cannot place a pull request at all", async () => {
    const e = env();
    const app = routes({ principalFor: async () => null });
    await authorize(app, e, 59);
    expect(published.map((u) => u.state)).toContain("unplaceable");
  });

  /**
   * Joining the queue is keyed by the entry, so a pull request already in it kept
   * whatever commit it joined with. The turn check is published against that
   * commit, so a stale one puts the check on an old commit and leaves the current
   * head without one — and a required check that never arrives blocks the merge
   * forever.
   */
  it("follows a pull request to its new commit when it is pushed to", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    published.length = 0;

    const moved = "f".repeat(40);
    await authorize(app, e, 59, { headSha: moved });

    expect(published.map((u) => u.headSha)).toContain(moved);
    const snapshot = await liveState(app, e);
    expect(snapshot.entries.find((entry) => entry.pullRequestNumber === 59)).toBeDefined();
  });

  it("keeps the queue working when publishing fails", async () => {
    const e = env();
    const app = routes({
      publishTurnCheck: async () => {
        throw new Error("GitHub is having a moment");
      },
    });
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");
  });
});

/** A policy bundle naming the queue's execution profile. */
function policyNamed(securityProfile: string) {
  return async () => ({
    policyDigest: `sha256:${"b".repeat(64)}`,
    pipelineDigest: `sha256:${"c".repeat(64)}`,
    requiredSuites: ["unit"],
    securityProfile,
    organizationId: "org_1",
    verifier: null,
  });
}

describe("nudging a held lane", () => {
  it("re-evaluates a device-only lane without taking the developer's turn", async () => {
    const e = env();
    let writes = 0;
    const app = routes({
      activePolicy: policyNamed("fresh"),
      mergeWrite: async () => {
        writes += 1;
        return { kind: "unknown" as const, detail: "unreadable" };
      },
      // `principalFor` maps pull request 59's author to "principal_59"; that is
      // the principal that has to be connected for a device-only entry to be
      // scheduler-eligible at all.
      authenticate: async () => ({ ok: true, principalId: "principal_59", githubUserId: "59", isAdmin: true }),
    });
    seedMembership("principal_59", "59");
    await heartbeat(app, e);
    await authorize(app, e, 59);

    const response = await app.request(
      `/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nudged: true, reason: "APP_DRIVEN" });
    expect(writes).toBe(0);
  });

  it("asks the installed App to write a server-executable lane", async () => {
    const e = env();
    let enabled = false;
    let writes = 0;
    const app = routes({
      activePolicy: async () => (enabled ? policyNamed("fast")() : null),
      mergeWrite: async () => {
        writes += 1;
        return { kind: "unknown" as const, detail: "unreadable" };
      },
    });
    await authorize(app, e, 59);

    enabled = true;
    const response = await app.request(
      `/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nudged: true, reason: "APP_DRIVEN" });
    expect(writes).toBe(1);
  });
});

describe("an accepted candidate verdict", () => {
  const pinned = {
    repositoryId: REPO,
    repositoryOwnerId: "162603603",
    workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    workflowSha: null,
    reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify-impl.yml@refs/heads/main",
    reusableWorkflowSha: null,
    expectedEventName: "repository_dispatch" as const,
    defaultBranchRef: "refs/heads/main",
  };
  const claims = {
    repository_id: REPO,
    repository_owner_id: "162603603",
    workflow_ref: pinned.workflowRef,
    workflow_sha: "5".repeat(40),
    job_workflow_ref: pinned.reusableWorkflowRef,
    job_workflow_sha: "6".repeat(40),
    run_id: "998877",
    run_attempt: "1",
    event_name: "repository_dispatch",
    ref: "refs/heads/main",
    jti: "jti-1",
  };

  function postVerdict(app: App, e: QueueRouteEnv, pr: number) {
    return app.request(
      `/v1/queue/${REPO}/candidate-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          pullRequestNumber: pr,
          candidateSha: "c".repeat(40),
          candidateTreeOid: TREE,
          baseSha: "b".repeat(40),
          accepted: true,
          suites: [{ name: "unit", outcome: "passed", durationMs: 100 }],
        }),
      },
      e,
    );
  }

  it("does not take a device-only lane when verification completes before its receipt", async () => {
    const e = env();
    let writes = 0;
    const app = routes({
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
      activePolicy: policyNamed("fresh"),
      mergeWrite: async () => {
        writes += 1;
        return { kind: "unknown" as const, detail: "unreadable" };
      },
      // `principalFor` maps pull request 59's author to "principal_59"; that is
      // the principal that has to be connected for a device-only entry to be
      // scheduler-eligible at all.
      authenticate: async () => ({ ok: true, principalId: "principal_59", githubUserId: "59", isAdmin: true }),
    });
    seedMembership("principal_59", "59");
    await heartbeat(app, e);
    await authorize(app, e, 59);

    const response = await postVerdict(app, e, 59);
    expect(response.status).toBe(202);
    expect(writes).toBe(0);
  });

  it("wakes the installed App when a server-executable candidate verdict arrives", async () => {
    const e = env();
    let enabled = false;
    let writes = 0;
    const app = routes({
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
      activePolicy: async () => (enabled ? policyNamed("fast")() : null),
      mergeWrite: async () => {
        writes += 1;
        return { kind: "unknown" as const, detail: "unreadable" };
      },
    });
    await authorize(app, e, 59);

    enabled = true;
    const response = await postVerdict(app, e, 59);
    expect(response.status).toBe(202);
    expect(writes).toBe(1);
  });
});
