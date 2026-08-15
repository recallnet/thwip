import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { fixturePolicy, queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { MergeIntent, MergeWriteOutcome } from "./merge-write.js";
import { loadQueueState } from "./queue-state.js";
import { buildSnapshot } from "./queue-operations.js";
import type { D1Like } from "./projection.js";
import { envelopeDigest } from "@thwip/queue-protocol";
import { reconcileTerminalEntries } from "./terminal-reconciliation.js";
import type { RecordFromIntentDeps } from "./record-from-intent.js";
import { withTransitionSigningLease } from "./transition-signing-lease.js";
import { tickAllQueues } from "./scheduled-tick.js";
import type { ReconciliationReads } from "./deadlines.js";

/**
 * The App performs the merge with the installation credential and keeps the
 * fast-forward guard in code this repository tests.
 */

const open: Array<{ close(): void }> = [];

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const LANDED = "e".repeat(40);

/** A head carrying a proof bound to the policy the stub below activates. */
const PROVEN = `feat: something

thwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlMQ0p6ZFdKcVpXTjBJanBiZXlKdVlXMWxJam9pWjJsMExYUnlaV1VpTENKa2FXZGxjM1FpT25zaWMyaGhNU0k2SWpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056Y2lmWDFkTENKd2NtVmthV05oZEdWVWVYQmxJam9pZFhKdU9uUm9kMmx3T21GMGRHVnpkR0YwYVc5dU9tTnBMWEoxYmpwMk1TSXNJbkJ5WldScFkyRjBaU0k2ZXlKelkyaGxiV0ZXWlhKemFXOXVJam9pTVNJc0luSmxjRzl6YVhSdmNua2lPbnNpY0hKdmRtbGtaWElpT2lKbmFYUm9kV0lpTENKdmQyNWxja2xrSWpvaU1TSXNJbkpsY0c5emFYUnZjbmxKWkNJNklqRXpNVFUwTVRreE5qVWlmU3dpWjJsMElqcDdJbTlpYW1WamRFWnZjbTFoZENJNkluTm9ZVEVpTENKMGNtVmxUMmxrSWpvaU56YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOeUlzSW5CaGNtVnVkRTlwWkhNaU9sc2lZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWWlKZExDSmlZWE5sVW1WbUlqb2ljbVZtY3k5b1pXRmtjeTl0WVdsdUlpd2lZbUZ6WlZOb1lTSTZJbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1JaUxDSmxkbUZzZFdGMGFXOXVUVzlrWlNJNkltaGxZV1F0ZEhKbFpTSjlMQ0p3YjJ4cFkza2lPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUlpTENKMlpYSnphVzl1SWpveGZTd2ljR2x3Wld4cGJtVWlPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbU5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk1pTENKeWRXNXVaWElpT2lKamIyMXRZVzVrSW4wc0luSjFiaUk2ZXlKemRHRnlkR1ZrUVhRaU9pSXlNREkyTFRBeExUQXhWREF3T2pBd09qQXdMakF3TUZvaUxDSm1hVzVwYzJobFpFRjBJam9pTWpBeU5pMHdNUzB3TVZRd01Eb3dNVG93TUM0d01EQmFJaXdpYm1WMGQyOXlhMDF2WkdVaU9pSmthWE5oWW14bFpDSXNJbU5oWTJobFRXOWtaU0k2SW1ScGMyRmliR1ZrSWl3aWMzVnBkR1Z6SWpwYmV5SnBaQ0k2SW5WdWFYUWlMQ0p6ZEdGMGRYTWlPaUp3WVhOelpXUWlMQ0prZFhKaGRHbHZiazF6SWpveGZWMTlMQ0p6YVdkdVpYSWlPbnNpYTJWNVNXUWlPaUpUU0VFeU5UWTZhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmF5SXNJbWRwZEdoMVlsVnpaWEpKWkNJNklqRWlmWDE5Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2trayIsInNpZyI6IkFBQUEifV19
`;

let raw: import("better-sqlite3").Database;
let fixtureSigningKey: CryptoKey;
let fixturePublicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  fixtureSigningKey = pair.privateKey;
  fixturePublicJwk = { ...(await exportJWK(pair.publicKey)), kid: "merge-in-worker-fixture", alg: "ES256" };
});

const signFixture = async (bytes: Uint8Array, typ: string) =>
  new CompactSign(bytes)
    .setProtectedHeader({ alg: "ES256", kid: fixturePublicJwk.kid, typ })
    .sign(fixtureSigningKey);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  t.raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  t.raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  t.raw
    .prepare(
      "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "author1");
  t.raw
    .prepare("INSERT OR IGNORE INTO service_keys (kid, public_jwk) VALUES (?, ?)")
    .run(fixturePublicJwk.kid, JSON.stringify(fixturePublicJwk));
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, baseSha: BASE, treeOid: TREE, candidateSha: CANDIDATE, headShaFor: () => HEAD }, {
      queueProject: async () => ({ activationState: "enforced", projectId: "proj_1" }),
      commitFacts: async (_e: unknown, _r: string, sha: string) =>
        sha === LANDED
          ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "Merge pull request #117 (Thwip Queue)" }
          : { treeOid: TREE, parentShas: [BASE, "6".repeat(40)], message: PROVEN },
      baseContainsSha: async () => true,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
      signRecordBytes: async (_environment: unknown, bytes: Uint8Array, typ: string) => signFixture(bytes, typ),
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

/** A write port that records the intent it was handed and answers as told. */
function writer(outcome: MergeWriteOutcome): {
  intents: MergeIntent[];
  port: (env: unknown, repositoryId: string, intent: MergeIntent) => Promise<MergeWriteOutcome>;
} {
  const intents: MergeIntent[] = [];
  return {
    intents,
    port: async (_env, _repositoryId, intent) => {
      intents.push(intent);
      return outcome;
    },
  };
}

async function authorize(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
): Promise<Record<string, unknown>> {
  acceptProof(raw, REPO, HEAD);
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: 117,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        draft: false,
      }),
    },
    e,
  );
  return (await response.json()) as Record<string, unknown>;
}

async function drive(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<Record<string, unknown>> {
  // The required workflow's authorization request is the event that arrives
  // when proof and CI become ready. It must wake the App writer itself rather
  // than relying on the five-minute queue heartbeat.
  return authorize(app, e);
}

async function entryState(e: QueueRouteEnv): Promise<string | null> {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return buildSnapshot(store).entries[0]?.state ?? null;
}

describe("the Worker performing the merge", () => {
  it("wakes immediately from a newly-ready authorization and hands the writer the pinned merge", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await drive(routes({ mergeWrite: w.port }), e);

    expect(w.intents).toHaveLength(1);
    expect(w.intents[0]).toMatchObject({
      baseRef: REF,
      pullRequestNumber: 117,
      baseSha: BASE,
      headSha: HEAD,
      treeOid: TREE,
      parentShas: [BASE, HEAD],
    });
  });

  /**
   * The trailer is how the queue tells its own merges from somebody else's
   * push, and the operation id in it is what the record binds.
   */
  it("writes the message the record binds", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await drive(routes({ mergeWrite: w.port }), e);
    expect(w.intents[0]?.message).toMatch(/Merge pull request #117 \(Thwip Queue\)/);
    expect(w.intents[0]?.message).toMatch(/thwip-queue-operation: merge_/);
  });

  it("does not expose merge pins or write results through the check API", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const answer = await authorize(routes({ mergeWrite: w.port }), e);
    expect(answer).not.toHaveProperty("merge");
    expect(answer).not.toHaveProperty("mergeWriter");
    expect(answer).not.toHaveProperty("merged");
    // The route captures this answer, then wakes the internal writer. The
    // side effect is real, but none of its authority or outcome crosses the
    // check-facing response boundary.
    expect(w.intents).toHaveLength(1);
  });

  it("does not let terminal repair sign while the normal merge callback owns the signer", async () => {
    const e = env();
    await runOnQueue(e, REPO, REF, ({ commands }) => {
      commands.requestQueue({
        idempotencyKey: "seed-before-terminal-read",
        entryId: `entry_${REPO}_117`,
        pullRequestNumber: 117,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: HEAD,
      });
      commands.evaluateReadiness({
        idempotencyKey: "block-before-terminal-read",
        entryId: `entry_${REPO}_117`,
        ready: false,
        schedulerEligible: false,
        primaryReason: "REVIEW_REQUIRED",
      });
    });

    let releasePullRead!: () => void;
    let announcePullRead!: () => void;
    const pullReadHeld = new Promise<void>((resolve) => {
      releasePullRead = resolve;
    });
    const pullReadStarted = new Promise<void>((resolve) => {
      announcePullRead = resolve;
    });
    const repairDeps: RecordFromIntentDeps<QueueRouteEnv> = {
      commitFacts: async (_environment, _repositoryId, sha) =>
        sha === LANDED
          ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "Merge pull request #117 (Thwip Queue)" }
          : { treeOid: TREE, parentShas: [], message: "base" },
      baseContainsSha: async () => true,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
      activePolicy: async () => fixturePolicy() as Awaited<ReturnType<RecordFromIntentDeps<QueueRouteEnv>["activePolicy"]>>,
      signRecordBytes: async () => {
        throw new Error("terminal repair signed while the normal callback held the lease");
      },
      storeEvidence: async () => "no-bucket",
      onQueue: (environment, repositoryId, baseRef, decide) =>
        runOnQueue(environment, repositoryId, baseRef, decide),
    };
    const repair = reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      {
        pullRequestState: async () => {
          announcePullRead();
          await pullReadHeld;
          return { state: "closed", merged: true, mergeCommitSha: LANDED, headSha: HEAD };
        },
      },
      repairDeps,
    );
    await pullReadStarted;

    let releaseNormalSigner!: () => void;
    let announceNormalSigner!: () => void;
    const normalSignerHeld = new Promise<void>((resolve) => {
      releaseNormalSigner = resolve;
    });
    const normalSignerStarted = new Promise<void>((resolve) => {
      announceNormalSigner = resolve;
    });
    const normal = authorize(
      routes({
        mergeWrite: writer({ kind: "merged", mergeSha: LANDED }).port,
        signRecordBytes: async (_environment, bytes, typ) => {
          if (typ.includes("transition-record")) {
            announceNormalSigner();
            await normalSignerHeld;
          }
          return signFixture(bytes, typ);
        },
      }),
      e,
    );
    await normalSignerStarted;

    releasePullRead();
    const repaired = await repair;
    expect(repaired.reconciled).toBe(0);

    releaseNormalSigner();
    await normal;
    const signed = raw
      .prepare("SELECT COUNT(*) AS count FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')")
      .get() as { count: number };
    expect(signed.count).toBe(1);
  });

  it("lets the heartbeat record a normal callback that lost the signing lease exactly once", async () => {
    const e = env();
    raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, enabled, activation_state, attested_from_sequence, project_id)
         VALUES ('queue_1', 'org_1', ?, ?, 1, 'enforced', 0, 'proj_1')`,
      )
      .run(REPO, REF);

    let releaseRepair!: () => void;
    let announceRepair!: () => void;
    const repairHeld = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const repairStarted = new Promise<void>((resolve) => {
      announceRepair = resolve;
    });
    const holdingRepair = withTransitionSigningLease(
      e.DB as unknown as D1Like,
      { repositoryId: REPO, baseRef: REF, owner: "terminal-repair-a" },
      async () => {
        announceRepair();
        await repairHeld;
      },
    );
    await repairStarted;

    const w = writer({ kind: "merged", mergeSha: LANDED });
    await authorize(routes({ mergeWrite: w.port }), e);
    expect(w.intents).toHaveLength(1);
    expect(await entryState(e)).toBe("Merged");
    expect(
      (
        raw
          .prepare(
            "SELECT COUNT(*) AS count FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')",
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);

    releaseRepair();
    await holdingRepair;
    const message = w.intents[0]!.message;
    const recordDeps: RecordFromIntentDeps<QueueRouteEnv> = {
      commitFacts: async (_environment, _repositoryId, sha) =>
        sha === LANDED
          ? { treeOid: TREE, parentShas: [BASE, HEAD], message }
          : sha === BASE
            ? { treeOid: "6".repeat(40), parentShas: [], message: "base" }
            : null,
      baseContainsSha: async () => true,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
      activePolicy: async () =>
        fixturePolicy() as Awaited<ReturnType<RecordFromIntentDeps<QueueRouteEnv>["activePolicy"]>>,
      signRecordBytes: async (_environment, bytes, typ) => signFixture(bytes, typ),
      storeEvidence: async () => "no-bucket",
      onQueue: (environment, repositoryId, baseRef, decide) =>
        runOnQueue(environment, repositoryId, baseRef, decide),
    };
    const heartbeatReads: ReconciliationReads = {
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
      baseContainsSha: async () => true,
      pullRequestNumbersForCommit: async () => [117],
      commitFacts: recordDeps.commitFacts,
      sleep: async () => {},
    };
    const ports = {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    };

    const repaired = await tickAllQueues(e, ports, heartbeatReads, recordDeps, {
      pullRequestState: async () => ({ state: "closed", merged: true, mergeCommitSha: LANDED, headSha: HEAD }),
    });
    const record = raw
      .prepare(
        "SELECT digest, transition_sequence AS sequence FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')",
      )
      .get() as { digest: string; sequence: number };
    raw.prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?").run(record.digest);

    const restored = await tickAllQueues(e, ports, heartbeatReads, recordDeps, {
      pullRequestState: async () => ({ state: "closed", merged: true, mergeCommitSha: LANDED, headSha: HEAD }),
    });
    const repeated = await tickAllQueues(e, ports, heartbeatReads, recordDeps, {
      pullRequestState: async () => ({ state: "closed", merged: true, mergeCommitSha: LANDED, headSha: HEAD }),
    });

    expect(repaired.settledWrites).toBe(1);
    expect(restored.settledWrites).toBe(1);
    expect(repeated.settledWrites).toBe(0);
    expect(
      (
        raw
          .prepare(
            "SELECT COUNT(*) AS count FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE digest = ?").get(record.digest) as {
          sequence: number | null;
        }
      ).sequence,
    ).toBe(record.sequence);
  });

  /**
   * Two authorization deliveries can overlap while the first App write is in
   * flight. The durable operation row is a no-retry guard, not a lease another
   * delivery may reuse. Two writers for one operation could otherwise let one
   * move the branch while the other records stale GitHub state.
   */
  it("sends exactly one App write when another wake arrives while it is in flight", async () => {
    const e = env();
    let writes = 0;
    let releaseWrite!: () => void;
    let announceWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
    const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const app = routes({
      mergeWrite: async () => {
        writes += 1;
        announceWrite();
        await released;
        return { kind: "unknown", detail: "the test leaves the first write to reconciliation" };
      },
    });

    const first = authorize(app, e);
    await writeStarted;
    const second = authorize(app, e);
    await second;

    expect(writes).toBe(1);
    releaseWrite();
    await first;
    expect(writes).toBe(1);
  });

  /**
   * The record asks GitHub whether the branch contains the commit before it
   * will sign, and this is the second read that races the App's own write. On
   * 4 August pull request 183 merged, the queue confirmed it, and no record was
   * written: the write had landed a second earlier and the comparison had not
   * caught up. The merge operation was resolved, so nothing revisited it.
   */
  it("waits for the ancestry read to catch up with its own write before giving up", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    let asked = 0;
    await authorize(
      routes({
        mergeWrite: w.port,
        baseContainsSha: async () => {
          asked += 1;
          return asked > 2;
        },
      }),
      e,
    );
    expect(asked).toBeGreaterThan(2);
    const record = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')")
      .get() as { digest: string } | undefined;
    expect(record?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /** A read that never agrees records nothing. The sweep asks again. */
  it("marks the merge operation for repair when the branch never says it contains the commit", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await authorize(routes({ mergeWrite: w.port, baseContainsSha: async () => false }), e);
    const records = raw
      .prepare("SELECT COUNT(*) AS count FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')")
      .get() as { count: number };
    expect(records.count).toBe(0);
    const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(store.mergeOperations()).toEqual([
      expect.objectContaining({
        outcome: "MERGED",
        refusalReason: expect.stringContaining("does not contain") as unknown as string,
        refusalCount: 1,
        retryAfter: expect.any(String) as unknown as string,
      }),
    ]);
  });

  it("keeps a durable repair reason when transition recording throws after the merge", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await authorize(
      routes({
        mergeWrite: w.port,
        signRecordBytes: async (_env, _bytes, typ) => {
          if (typ.includes("transition-record")) throw new Error("injected signer outage");
          return "signed-intent";
        },
      }),
      e,
    );

    expect(w.intents).toHaveLength(1);
    const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(store.mergeOperations()).toEqual([
      expect.objectContaining({
        outcome: "MERGED",
        refusalReason: expect.stringContaining("injected signer outage") as unknown as string,
        refusalCount: 1,
        retryAfter: expect.any(String) as unknown as string,
      }),
    ]);
  });

  it("does not link signed bytes at a different position when the chain moves before append", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const competitor = `sha256:${"9".repeat(64)}`;
    let attemptedDigest: string | null = null;
    await authorize(
      routes({
        mergeWrite: w.port,
        signRecordBytes: async (_env, bytes, typ) => {
          if (typ.includes("transition-record")) {
            attemptedDigest = await envelopeDigest(bytes);
            await runOnQueue(e, REPO, REF, ({ commands }) =>
              commands.recordTransition({
                idempotencyKey: "injected-competing-transition",
                kind: "reused",
                transitionSequence: 1,
                priorDigest: null,
                digest: competitor,
                baseSha: "8".repeat(40),
                attemptId: null,
                witnessPrincipalIds: [],
              }),
            );
          }
          return "test-jws";
        },
      }),
      e,
    );

    expect(attemptedDigest).toMatch(/^sha256:/);
    const links = raw.prepare("SELECT digest FROM queue_transitions_index ORDER BY transition_sequence").all() as Array<{
      digest: string;
    }>;
    expect(links.map((link) => link.digest)).toEqual([competitor]);
    expect(links.some((link) => link.digest === attemptedDigest)).toBe(false);
  });

  it("writes a signed record for the merge it performed", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await drive(routes({ mergeWrite: w.port }), e);
    const record = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')")
      .get() as { digest: string } | undefined;
    expect(record?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records a landed merge with its original lease when release starts during the write", async () => {
    const e = env();
    const app = routes({
      mergeWrite: async () => {
        raw.prepare(
          `INSERT INTO project_release_requests
             (github_repository_id, project_id, organization_id, github_name, default_branch)
           VALUES (?, 'proj_1', 'org_1', 'acme/repo', 'main')`,
        ).run(REPO);
        return { kind: "merged", mergeSha: LANDED };
      },
    });

    await drive(app, e);

    expect(raw.prepare("SELECT COUNT(*) AS n FROM project_release_requests").get()).toEqual({ n: 1 });
    const record = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge')")
      .get() as { digest: string } | undefined;
    expect(record?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM queue_transitions_index").get()).toEqual({ n: 1 });
  });

  /**
   * The candidate was verified against a base that no longer exists, so the
   * queue takes the turn back rather than reaching for the new base.
   */
  it("frees the lane when the base moved under it", async () => {
    const e = env();
    const w = writer({ kind: "base-moved", detail: "the base branch is no longer " + BASE });
    await drive(routes({ mergeWrite: w.port }), e);
    expect(await entryState(e)).toBe("Deferred");
  });

  it("leaves an outcome it could not read to reconciliation", async () => {
    const e = env();
    const w = writer({ kind: "unknown", detail: "GitHub could not be read" });
    await drive(routes({ mergeWrite: w.port }), e);
    expect(await entryState(e)).toBe("Reconciling");
  });

});
