import { afterEach, describe, expect, it, vi } from "vitest";
import { fixturePolicy, queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { withQueueState } from "./queue-state.js";
import { buildSnapshot } from "./queue-operations.js";
import { tickAllQueues } from "./scheduled-tick.js";
import type { D1Like } from "./projection.js";
import type { Env } from "../env.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool. Stubbing that
// one export lets `queueFromPullRequest` load under plain node, the same way
// every other control-plane unit test avoids the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
const { queueFromPullRequest } = await import("../index.js");

/**
 * Eligibility, derived rather than written by whichever writer ran last
 * (plan.md §452).
 *
 * Under `fresh`/`audited` a queue entry offers the lane only to a connected
 * developer's own machine, with no fallback to GitHub Actions. The defining
 * property is that an entry with no connected runner keeps its fairness
 * ordinal, receives no offer, and blocks nobody — that is what makes having
 * no Actions fallback tolerable. Before this file, `schedulerEligible` was
 * written independently by the pull-request webhook, `/authorize`, the
 * heartbeat route and the scheduled tick, and none of the first two folded in
 * runner presence, so `/authorize` — called on every push and every poll —
 * overwrote `AGENT_OFFLINE` with eligibility on every call.
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

const REPO = "1315419165";
const REF = "refs/heads/main";
const ORG = "org_1";

/**
 * A repository whose active policy names `securityProfile`, a principal per
 * author id, and the App's passing verdict on each of their heads.
 *
 * The proof is part of the setup because this file is about runner presence.
 * A head the App has not verified is blocked on that instead, which is a true
 * answer to a different question.
 */
function seed(securityProfile: string, authorGithubUserIds: number[]) {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(ORG, "1", "acme");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, 1, 'enforced')",
    )
    .run("qp_1", ORG, REPO, REF);
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled, active_policy_digest) VALUES (?, ?, ?, ?, 1, ?)",
    )
    .run("proj_1", ORG, REPO, "acme/repo", `sha256:${"d".repeat(64)}`);
  raw
    .prepare(
      "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, ?, 1, ?, 'active')",
    )
    .run(`sha256:${"d".repeat(64)}`, "proj_1", JSON.stringify({ schemaVersion: "1", securityProfile, version: 1 }));
  for (const id of authorGithubUserIds) {
    acceptProof(raw, REPO, String(id).padStart(40, "a"));
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(`principal_${id}`, ORG, String(id), `author${id}`);
  }
}

function openedPayload(pr: number, authorGithubUserId: number) {
  return {
    action: "opened",
    pull_request: {
      number: pr,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: String(pr).padStart(40, "a") },
      user: { id: authorGithubUserId, login: `author${authorGithubUserId}`, type: "User" },
    },
  };
}

async function snapshotEntries(e: QueueRouteEnv) {
  const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
  return snapshot.entries;
}

function entryFor(entries: Awaited<ReturnType<typeof snapshotEntries>>, pr: number) {
  return entries.find((entry) => entry.pullRequestNumber === pr);
}

/** A routes app whose session belongs to `principalId`, so it can heartbeat as that principal. */
function routesAs(principalId: string, securityProfile: string) {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, principalId, githubUserId: principalId.replace("principal_", "") }, {
      activePolicy: async () => fixturePolicy({ securityProfile }),
    }) as Parameters<typeof queueRoutes>[0],
  );
}

/** A device id shaped the way `thwip queue work` sends one: a signing key fingerprint. */
const DEVICE = `SHA256:${"a".repeat(43)}`;

function heartbeat(app: ReturnType<typeof routesAs>, e: QueueRouteEnv, deviceKeyId = DEVICE) {
  return app.request(
    `/v1/queue/${REPO}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId }) },
    e,
  );
}

async function authorize(app: ReturnType<typeof routesAs>, e: QueueRouteEnv, pullRequestNumber: number) {
  acceptProof(raw, REPO, String(pullRequestNumber).padStart(40, "a"));
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber,
        headSha: String(pullRequestNumber).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pullRequestNumber),
        draft: false,
      }),
    },
    e,
  );
  return (await response.json()) as { authorized: boolean; reason: string };
}

describe("scheduler eligibility, under a device-only profile", () => {
  it("is not scheduler-eligible with no live heartbeat, and /authorize does not make it eligible", async () => {
    const e = env();
    seed("fresh", [59]);

    const opened = await queueFromPullRequest(e as unknown as Env, openedPayload(59, 59));
    expect(opened.handled).toBe(true);

    const afterOpen = entryFor(await snapshotEntries(e), 59);
    expect(afterOpen?.schedulerEligible).toBe(false);
    expect(afterOpen?.primaryReason).toBe("AGENT_OFFLINE");

    // The required check: called on every push and every poll. This is the
    // regression under test — it must not overwrite AGENT_OFFLINE with
    // eligibility just because the proof was accepted and the pull request
    // is not a draft.
    const app = routesAs("principal_59", "fresh");
    const verdict = await authorize(app, e, 59);
    expect(verdict.authorized).toBe(false);

    const afterAuthorize = entryFor(await snapshotEntries(e), 59);
    expect(afterAuthorize?.schedulerEligible).toBe(false);
    expect(afterAuthorize?.primaryReason).toBe("AGENT_OFFLINE");
  });

  it("becomes eligible once a heartbeat arrives, and does not have that undone by a later /authorize call once the runner has gone offline again", async () => {
    const e = env();
    seed("fresh", [59]);
    await queueFromPullRequest(e as unknown as Env, openedPayload(59, 59));
    expect(entryFor(await snapshotEntries(e), 59)?.schedulerEligible).toBe(false);

    const app = routesAs("principal_59", "fresh");
    await heartbeat(app, e);

    const afterHeartbeat = entryFor(await snapshotEntries(e), 59);
    expect(afterHeartbeat?.schedulerEligible).toBe(true);
    expect(afterHeartbeat?.primaryReason).toBeNull();

    // The laptop closes. The tick — not a heartbeat — is what notices: it
    // retires the stale runner and writes AGENT_OFFLINE back onto the entry,
    // exactly as `scheduled-tick.ts` does every five minutes.
    raw.prepare("UPDATE queue_runners SET last_heartbeat_at = '2000-01-01T00:00:00.000Z'").run();
    await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });
    const afterTick = entryFor(await snapshotEntries(e), 59);
    expect(afterTick?.schedulerEligible).toBe(false);
    expect(afterTick?.primaryReason).toBe("AGENT_OFFLINE");

    // This is the regression itself: the required check is called on every
    // push and every poll, and it must not overwrite what the tick just
    // wrote just because the proof is accepted and the pull request is not a
    // draft.
    await authorize(app, e, 59);
    const afterAuthorize = entryFor(await snapshotEntries(e), 59);
    expect(afterAuthorize?.schedulerEligible).toBe(false);
    expect(afterAuthorize?.primaryReason).toBe("AGENT_OFFLINE");
  });

  it("is eligible when the developer is already connected before the pull request opens", async () => {
    const e = env();
    seed("fresh", [59]);

    const app = routesAs("principal_59", "fresh");
    // Connects before the pull request exists at all — there is no
    // absent-to-present transition for the webhook to ride.
    await heartbeat(app, e);

    await queueFromPullRequest(e as unknown as Env, openedPayload(59, 59));

    const entry = entryFor(await snapshotEntries(e), 59);
    expect(entry?.schedulerEligible).toBe(true);
    expect(entry?.primaryReason).toBeNull();
  });

  it("keeps the offline entry's fairness ordinal and does not block a Ready entry behind it", async () => {
    const e = env();
    seed("fresh", [59, 61]);

    // 59 opens first, with nobody connected: offline, but first in line.
    await queueFromPullRequest(e as unknown as Env, openedPayload(59, 59));
    // 61 opens second, already connected.
    const app61 = routesAs("principal_61", "fresh");
    await heartbeat(app61, e);
    await queueFromPullRequest(e as unknown as Env, openedPayload(61, 61));

    const entries = await snapshotEntries(e);
    const e59 = entryFor(entries, 59);
    const e61 = entryFor(entries, 61);

    expect(e59?.fairnessOrdinal).toBeDefined();
    expect(e61?.fairnessOrdinal).toBeDefined();
    // 59 arrived first, so its ordinal still sorts before 61's — it kept its
    // place rather than losing it to the machine that showed up.
    expect(e59!.fairnessOrdinal < e61!.fairnessOrdinal).toBe(true);

    // The offline entry never blocks: the connected one behind it gets the
    // lane instead.
    expect(e59?.state).not.toBe("Offered");
    expect(e59?.state).not.toBe("Active");
    expect(e61?.state === "Offered" || e61?.state === "Active").toBe(true);
  });
});

describe("scheduler eligibility, under a non-device profile", () => {
  it("ignores runner presence entirely: an entry is eligible with no runner connected at all", async () => {
    const e = env();
    seed("fast", [59]);

    await queueFromPullRequest(e as unknown as Env, openedPayload(59, 59));
    const afterOpen = entryFor(await snapshotEntries(e), 59);
    expect(afterOpen?.schedulerEligible).toBe(true);
    expect(afterOpen?.primaryReason).toBeNull();

    const app = routesAs("principal_59", "fast");
    await authorize(app, e, 59);
    const afterAuthorize = entryFor(await snapshotEntries(e), 59);
    expect(afterAuthorize?.schedulerEligible).toBe(true);
    expect(afterAuthorize?.primaryReason).toBeNull();
  });
});
