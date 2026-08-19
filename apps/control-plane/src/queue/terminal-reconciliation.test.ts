import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { signReusedIntent } from "./attestation.js";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import type { D1Like } from "./projection.js";
import { readProjectedQueue } from "./projection.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";
import { withQueueState } from "./queue-state.js";
import { mergeCommitText } from "./merge-commit.js";
import { reconcileTerminalEntries } from "./terminal-reconciliation.js";
import type { TerminalPullRequestReads } from "./deadlines.js";
import { projectQueueState } from "./projection.js";

const REPO = "1315419165";
const REF = "refs/heads/main";
const BASE = "a1".repeat(20);
const HEAD = "b2".repeat(20);
const MERGE = "c3".repeat(20);
const TREE = "d4".repeat(20);
const BEFORE_TREE = "e5".repeat(20);
const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let signingKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "terminal-reconciliation-test", alg: "ES256" };
});

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_terminal', '1', 'acme')")
    .run();
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('prj_terminal', 'org_terminal', ?, 'acme/repo', 1)",
    )
    .run(REPO);
  raw
    .prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?)")
    .run(publicJwk.kid, JSON.stringify(publicJwk));
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

async function blocked(e: QueueRouteEnv, pr: number, headSha = HEAD): Promise<void> {
  await runOnQueue(e, REPO, REF, ({ commands }) => {
    commands.requestQueue({
      idempotencyKey: `request-${pr}`,
      entryId: `entry_${REPO}_${pr}`,
      pullRequestNumber: pr,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha,
    });
    commands.evaluateReadiness({
      idempotencyKey: `blocked-${pr}`,
      entryId: `entry_${REPO}_${pr}`,
      ready: false,
      schedulerEligible: false,
      primaryReason: "REVIEW_REQUIRED",
    });
  });
}

async function offered(e: QueueRouteEnv, pr: number): Promise<void> {
  await runOnQueue(e, REPO, REF, async ({ commands }) => {
    commands.requestQueue({
      idempotencyKey: `request-${pr}`,
      entryId: `entry_${REPO}_${pr}`,
      pullRequestNumber: pr,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha: HEAD,
    });
    commands.evaluateReadiness({
      idempotencyKey: `ready-${pr}`,
      entryId: `entry_${REPO}_${pr}`,
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
    });
    await commands.tick({ idempotencyKey: `offer-${pr}` });
  });
}

/** Keep the target old enough that its terminal transition compacts it at once. */
async function fillWithNewerTerminals(e: QueueRouteEnv, firstPr = 1_000): Promise<void> {
  await runOnQueue(e, REPO, REF, ({ commands }) => {
    for (let offset = 0; offset < 20; offset += 1) {
      const pr = firstPr + offset;
      const entryId = `entry_${REPO}_${pr}`;
      commands.requestQueue({
        idempotencyKey: `request-${pr}`,
        entryId,
        pullRequestNumber: pr,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: pr.toString().repeat(40).slice(0, 40),
      });
      commands.cancel({
        idempotencyKey: `cancel-${pr}`,
        entryId,
        actorPrincipalId: "github",
        reason: "closed on GitHub",
      });
    }
  });
}

/** Fail only final terminal-entry history writes, not queue authority itself. */
function failingTerminalHistory(
  db: D1Like,
  pullRequestNumber: number,
  failures: { remaining: number },
): D1Like {
  return {
    prepare(query: string) {
      const prepared = db.prepare(query);
      if (!query.includes("INSERT INTO queue_entries_index")) return prepared;
      return {
        bind(...values: unknown[]) {
          const bound = prepared.bind(...values);
          return {
            ...bound,
            async run() {
              if (
                failures.remaining > 0 &&
                values[4] === pullRequestNumber &&
                (values[6] === "Merged" || values[6] === "Cancelled")
              ) {
                failures.remaining -= 1;
                throw new Error("D1 terminal projection unavailable");
              }
              return bound.run();
            },
          };
        },
      } as ReturnType<D1Like["prepare"]>;
    },
    batch: (statements) => db.batch(statements),
  };
}

async function seedIntent(pr: number, attemptId = `att_${pr}`): Promise<void> {
  const signed = await signReusedIntent({
    operationId: `merge_${attemptId}`,
    attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: BASE,
      headRepositoryId: REPO,
      headSha: HEAD,
      candidateSha: "9".repeat(40),
      candidateTreeOid: TREE,
      candidateParentOids: [BASE, HEAD],
    },
    position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: pr,
    mergeMethod: "merge",
    evidence: {
      workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
      organizationId: "org_acme",
      policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
      pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
      requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
      proofCheckRunId: "91289436271",
    },
    createdAt: "2026-08-05T20:00:00.000Z",
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at, project_id)
       VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?, ?, 'prj_terminal')`,
    )
    .run(
      signed.digest,
      REPO,
      REF,
      attemptId,
      new TextDecoder().decode(signed.bytes),
      signed.jws,
      "2026-08-05T20:00:00.000Z",
    );
}

function deps(pr: number): RecordFromIntentDeps<QueueRouteEnv> {
  return {
    commitFacts: async (_env, _repositoryId, sha) =>
      sha === MERGE
        ? { treeOid: TREE, parentShas: [BASE, HEAD], message: mergeCommitText(pr, `merge_att_${pr}`).replace(/\n$/, "") }
        : sha === BASE
          ? { treeOid: BEFORE_TREE, parentShas: ["5".repeat(40)], message: "base" }
          : null,
    baseContainsSha: async () => true,
    pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: MERGE }),
    activePolicy: async () => ({
      policyDigest: `sha256:${"2".repeat(64)}`,
      pipelineDigest: `sha256:${"3".repeat(64)}`,
      requiredSuites: ["unit"],
      organizationId: "org_acme",
    }),
    signRecordBytes: async (_environment, bytes, typ) =>
      new CompactSign(bytes)
        .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid, typ })
        .sign(signingKey),
    storeEvidence: async () => "no-bucket",
    onQueue: (environment, repositoryId, baseRef, decide) =>
      runOnQueue(environment, repositoryId, baseRef, decide),
  };
}

function reads(state: "open" | "closed", merged = false): TerminalPullRequestReads {
  return {
    pullRequestState: async () => ({
      state,
      merged,
      mergeCommitSha: merged ? MERGE : null,
      headSha: HEAD,
    }),
  };
}

async function snapshot(e: QueueRouteEnv) {
  return withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
}

describe("bounded terminal queue reconciliation", () => {
  it("removes an observe-mode entry that merged outside Thwip without inventing a signed merge", async () => {
    const e = env();
    const pr = 246;
    await runOnQueue(e, REPO, REF, ({ commands }) => {
      commands.requestQueue({
        idempotencyKey: `request-${pr}`,
        entryId: `entry_${REPO}_${pr}`,
        pullRequestNumber: pr,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: HEAD,
      });
    });

    const first = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      reads("closed", true),
      deps(pr),
    );
    const repeated = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      reads("closed", true),
      deps(pr),
    );

    expect(first).toMatchObject({ examined: 1, reconciled: 1 });
    expect(repeated).toMatchObject({ examined: 0, reconciled: 0 });
    expect((await snapshot(e)).entries[0]).toMatchObject({ state: "Cancelled" });
    expect(
      raw
        .prepare(
          "SELECT state FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
        )
        .get(REPO, REF, pr),
    ).toEqual({ state: "Cancelled" });
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge', 'candidate-verified-merge')",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM queue_transitions_index").get()).toEqual({ n: 0 });
  });

  it("does not call a mismatched landed commit external when a Thwip intent exists for that pull request", async () => {
    const e = env();
    const pr = 247;
    await seedIntent(pr);
    await blocked(e, pr);
    const mismatched: RecordFromIntentDeps<QueueRouteEnv> = {
      ...deps(pr),
      commitFacts: async (_environment, _repositoryId, sha) =>
        sha === MERGE
          ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "merged by somebody else" }
          : { treeOid: BEFORE_TREE, parentShas: ["5".repeat(40)], message: "base" },
    };

    const result = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      reads("closed", true),
      mismatched,
    );

    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect((await snapshot(e)).entries[0]?.state).toBe("Blocked");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM queue_transitions_index").get()).toEqual({ n: 0 });
  });

  it("settles an already-merged entry from its existing record without signing another", async () => {
    const e = env();
    const pr = 237;
    await seedIntent(pr);
    const first = await recordMergeFromIntent(e, deps(pr), {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: MERGE,
      witnessPrincipalId: "queue",
      reason: "seed the existing record",
    });
    expect(first.status).toBe("recorded");
    await blocked(e, pr);
    const before = raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE kind != 'merge-intent'").get() as {
      n: number;
    };

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));

    expect(result.reconciled).toBe(1);
    expect((await snapshot(e)).entries[0]).toMatchObject({ state: "Merged", lastAttemptId: `att_${pr}` });
    const after = raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE kind != 'merge-intent'").get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });

  it("does not settle from an exact record whose service signature is invalid", async () => {
    const e = env();
    const pr = 240;
    await seedIntent(pr);
    const first = await recordMergeFromIntent(e, deps(pr), {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: MERGE,
      witnessPrincipalId: "queue",
      reason: "seed a record whose signature is then damaged",
    });
    expect(first.status).toBe("recorded");
    raw.prepare("UPDATE queue_attestations SET jws = 'garbled' WHERE digest = ?").run(first.transitionDigest);
    await blocked(e, pr);

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));

    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect((await snapshot(e)).entries[0]?.state).toBe("Blocked");
  });

  it("does not settle from a signed record whose public position disagrees with its link", async () => {
    const e = env();
    const pr = 241;
    await seedIntent(pr);
    const first = await recordMergeFromIntent(e, deps(pr), {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: MERGE,
      witnessPrincipalId: "queue",
      reason: "seed a record whose public position is then damaged",
    });
    expect(first.status).toBe("recorded");
    raw
      .prepare("UPDATE queue_attestations SET transition_sequence = transition_sequence + 10 WHERE digest = ?")
      .run(first.transitionDigest);
    await blocked(e, pr);

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));

    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect((await snapshot(e)).entries[0]?.state).toBe("Blocked");
  });

  it("recovers the first record from a signed intent before settling a merged entry", async () => {
    const e = env();
    const pr = 238;
    await seedIntent(pr);
    await blocked(e, pr);

    const first = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));
    const again = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));

    expect(first.reconciled).toBe(1);
    expect(again).toMatchObject({ reconciled: 0, examined: 0 });
    expect((await snapshot(e)).entries[0]?.state).toBe("Merged");
    expect(
      (
        raw
          .prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE transition_sequence IS NOT NULL")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("projects an old merged entry after compaction and repeats without another record", async () => {
    const e = env();
    const pr = 243;
    await seedIntent(pr);
    await blocked(e, pr);
    await fillWithNewerTerminals(e);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, 99, 'blocked', '2026-08-12T12:00:00Z', 'prj_terminal')",
      )
      .run(REPO, REF, pr);

    const first = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), deps(pr));
    // Reproduce the live deploy-window shape: the terminal event is in recent
    // authority, but the pre-fix publisher left its older blocked D1 row.
    raw
      .prepare(
        "UPDATE queue_entries_index SET state = 'Blocked', last_attempt_id = NULL WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
      )
      .run(REPO, REF, pr);
    const again = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("open"), deps(pr));

    expect(first).toMatchObject({ reconciled: 1, examined: 1 });
    expect(again).toMatchObject({ reconciled: 0, examined: 0 });
    expect((await snapshot(e)).entries.some((entry) => entry.pullRequestNumber === pr)).toBe(false);
    expect(
      raw
        .prepare(
          "SELECT state, generation FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
        )
        .get(REPO, REF, pr),
    ).toMatchObject({ state: "Merged" });
    expect(
      (
        raw
          .prepare(
            "SELECT COUNT(*) AS n FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge', 'candidate-verified-merge')",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(
      await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) =>
        store.pendingTerminalEntryProjections(),
      ),
    ).toEqual([]);
  });

  it("recovers a pre-handoff closed-unmerged row from its recent authoritative event", async () => {
    const e = env();
    const pr = 245;
    await blocked(e, pr);
    await fillWithNewerTerminals(e);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, 99, 'blocked', '2026-08-12T12:00:00Z', 'prj_terminal')",
      )
      .run(REPO, REF, pr);
    await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed"), deps(pr));
    raw
      .prepare(
        "UPDATE queue_entries_index SET state = 'Blocked' WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
      )
      .run(REPO, REF, pr);

    const noRead: TerminalPullRequestReads = {
      pullRequestState: async () => {
        throw new Error("an empty compatibility retry read GitHub");
      },
    };
    const retry = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, noRead, deps(pr));

    expect(retry).toMatchObject({ reconciled: 0, examined: 0 });
    expect(
      raw
        .prepare(
          "SELECT state FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
        )
        .get(REPO, REF, pr),
    ).toEqual({ state: "Cancelled" });
  });

  it("keeps a compacted cancellation pending through D1 failure and publishes it on an empty retry", async () => {
    const e = env();
    const pr = 244;
    await blocked(e, pr);
    await fillWithNewerTerminals(e);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, 99, 'blocked', '2026-08-12T12:00:00Z', 'prj_terminal')",
      )
      .run(REPO, REF, pr);
    const failures = { remaining: 2 };
    (e as { DB: unknown }).DB = failingTerminalHistory(e.DB as unknown as D1Like, pr, failures);

    await expect(
      reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed"), deps(pr)),
    ).rejects.toThrow("D1 terminal projection unavailable");
    expect((await snapshot(e)).entries.some((entry) => entry.pullRequestNumber === pr)).toBe(false);
    expect(
      await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) =>
        store.pendingTerminalEntryProjections().map((row) => ({
          pullRequestNumber: row.pullRequestNumber,
          terminalCommentPriority: row.terminalCommentPriority,
        })),
      ),
    ).toEqual([{ pullRequestNumber: pr, terminalCommentPriority: true }]);

    const noRead: TerminalPullRequestReads = {
      pullRequestState: async () => {
        throw new Error("an empty retry read GitHub");
      },
    };
    const retry = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, noRead, deps(pr));
    const repeated = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, noRead, deps(pr));
    expect(retry).toMatchObject({ reconciled: 0, examined: 0 });
    expect(repeated).toMatchObject({ reconciled: 0, examined: 0 });
    const terminal = raw
      .prepare(
        "SELECT e.state, e.generation, m.generation AS current_generation FROM queue_entries_index e JOIN queue_projection_marks m ON m.github_repository_id = e.github_repository_id AND m.base_ref = e.base_ref WHERE e.github_repository_id = ? AND e.base_ref = ? AND e.pull_request_number = ?",
      )
      .get(REPO, REF, pr) as { state: string; generation: number; current_generation: number };
    expect(terminal).toMatchObject({ state: "Cancelled" });
    expect(terminal.generation).toBeLessThan(terminal.current_generation);
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
        )
        .get(REPO, REF, pr),
    ).toEqual({ n: 1 });
    expect(
      await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) =>
        store.pendingTerminalEntryProjections(),
      ),
    ).toEqual([]);
  });

  it("restores a missing link projection and public position before deciding whether to sign", async () => {
    const e = env();
    const pr = 242;
    await seedIntent(pr);
    const first = await recordMergeFromIntent(e, deps(pr), {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: MERGE,
      witnessPrincipalId: "queue",
      reason: "seed authority before projection loss",
    });
    if (first.status !== "recorded") throw new Error("the exact record fixture did not record");
    await blocked(e, pr);

    // queue_state still carries this exact link. Only its best-effort index and
    // the public position were lost, which must be repaired before any signer
    // is called.
    raw.prepare("DELETE FROM queue_transitions_index WHERE digest = ?").run(first.transitionDigest);
    raw.prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?").run(first.transitionDigest);
    let signed = 0;
    const noReplacement: RecordFromIntentDeps<QueueRouteEnv> = {
      ...deps(pr),
      signRecordBytes: async (...args) => {
        signed += 1;
        return deps(pr).signRecordBytes(...args);
      },
    };

    const result = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      reads("closed", true),
      noReplacement,
    );

    expect(result.reconciled).toBe(1);
    expect(signed).toBe(0);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE digest = ?").all(first.transitionDigest)).toHaveLength(1);
    expect(
      raw
        .prepare("SELECT digest FROM queue_attestations WHERE kind IN ('verified-merge', 'reused-proof-merge', 'candidate-verified-merge')")
        .all(),
    ).toHaveLength(1);
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE digest = ?").get(first.transitionDigest),
    ).toEqual({ sequence: first.sequence });
  });

  it("retries the authoritative projection after the last entry is already terminal", async () => {
    const e = env();
    await blocked(e, 239);
    await projectQueueState(
      e.DB as unknown as D1Like,
      {
        repositoryId: REPO,
        baseRef: REF,
        queueEpoch: 0,
        generation: 10_000,
        activeAttemptId: null,
        paused: false,
        pauseReason: null,
        rebaselineRequired: false,
        baseSha: null,
        entries: [],
        transitions: [],
      },
    );

    const closed = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed"), deps(239));
    expect(closed.reconciled).toBe(1);
    // The injected future marker made both best-effort publications stale; it
    // stands in for a failed projection after the authority committed.
    raw
      .prepare("DELETE FROM queue_projection_marks WHERE github_repository_id = ? AND base_ref = ?")
      .run(REPO, REF);

    const emptyRetry = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("open"), deps(239));
    expect(emptyRetry).toMatchObject({ reconciled: 0, examined: 0 });
    const projected = await readProjectedQueue(e.DB as unknown as D1Like, REPO, REF, {
      entriesPage: 1,
      transitionsPage: 1,
      pageSize: 20,
    });
    expect(projected?.entries).toEqual([]);
  });

  it("cancels a closed-unmerged lane holder and frees the lane", async () => {
    const e = env();
    await offered(e, 219);
    expect((await snapshot(e)).activeAttemptId).not.toBeNull();

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed"), deps(219));

    expect(result.reconciled).toBe(1);
    expect(result.snapshot.activeAttemptId).toBeNull();
    expect(result.snapshot.entries[0]?.state).toBe("Cancelled");
  });

  it("preserves an open pull request", async () => {
    const e = env();
    await blocked(e, 41);
    const before = await snapshot(e);

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("open"), deps(41));

    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect((await snapshot(e)).entries[0]).toMatchObject({ state: before.entries[0]?.state });
  });

  it("leaves a live merge attempt to its ordinary merge callback", async () => {
    const e = env();
    await offered(e, 43);
    const forbidden: RecordFromIntentDeps<QueueRouteEnv> = {
      ...deps(43),
      commitFacts: async () => {
        throw new Error("terminal reconciliation tried to recover a live merge attempt");
      },
    };

    const result = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      reads("closed", true),
      forbidden,
    );

    expect(result).toMatchObject({ examined: 1, reconciled: 0 });
    expect((await snapshot(e)).entries[0]?.state).toBe("Offered");
  });

  it("lets only one overlapping heartbeat recover a missing signed record", async () => {
    const e = env();
    const pr = 44;
    await seedIntent(pr);
    await blocked(e, pr);
    let signed = 0;
    const baseDeps = deps(pr);
    const racingDeps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...baseDeps,
      signRecordBytes: async (environment, bytes, typ) => {
        signed += 1;
        return baseDeps.signRecordBytes(environment, bytes, typ);
      },
    };

    const outcomes = await Promise.all([
      reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), racingDeps),
      reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, reads("closed", true), racingDeps),
    ]);

    expect(outcomes.reduce((total, outcome) => total + outcome.reconciled, 0)).toBe(1);
    expect(signed).toBe(2); // one transition record and its repair audit
    expect(
      (
        raw
          .prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE transition_sequence IS NOT NULL")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("does not let an overlapping heartbeat claim the next page while signing may be in flight", async () => {
    const e = env();
    for (let pr = 1; pr <= 4; pr += 1) await blocked(e, pr);
    let releaseRead!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let announceRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    let announced = false;
    const firstReads: TerminalPullRequestReads = {
      pullRequestState: async () => {
        if (!announced) {
          announced = true;
          announceRead();
          await held;
        }
        return { state: "open", merged: false, mergeCommitSha: null, headSha: HEAD };
      },
    };

    const first = reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, firstReads, deps(1));
    await readStarted;
    const overlapping = await reconcileTerminalEntries(
      e,
      { repositoryId: REPO, baseRef: REF },
      {
        pullRequestState: async () => {
          throw new Error("an overlapping claim reached GitHub");
        },
      },
      deps(1),
    );
    releaseRead();
    await first;

    expect(overlapping).toMatchObject({ examined: 0, reconciled: 0 });
  });

  it("does not cancel a close-and-reopen admission that races the GitHub read", async () => {
    const e = env();
    await blocked(e, 42);
    const racingReads: TerminalPullRequestReads = {
      pullRequestState: async () => {
        await runOnQueue(e, REPO, REF, ({ commands, store }) => {
          const entry = store.state().entries.get(`entry_${REPO}_42`)!;
          commands.cancel({
            idempotencyKey: "webhook-close-42",
            entryId: entry.entryId,
            actorPrincipalId: "github",
            reason: "closed",
          });
          commands.requestQueue({
            idempotencyKey: "webhook-reopen-42",
            entryId: entry.entryId,
            pullRequestNumber: 42,
            sponsorPrincipalId: "alice",
            sponsorGithubUserId: "1",
            headSha: HEAD,
            resetOrdinal: true,
          });
        });
        return { state: "closed", merged: false, mergeCommitSha: null, headSha: HEAD };
      },
    };

    const result = await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, racingReads, deps(42));

    expect(result.reconciled).toBe(0);
    expect((await snapshot(e)).entries[0]).toMatchObject({ state: "Requested", fairnessOrdinal: "2" });
  });

  it("pages through every nonterminal entry and publishes each terminal result", async () => {
    const e = env();
    for (let pr = 1; pr <= 7; pr += 1) await blocked(e, pr, pr.toString().repeat(40).slice(0, 40));
    const asked: number[] = [];
    const terminalReads: TerminalPullRequestReads = {
      pullRequestState: async (_env, _repositoryId, pullRequestNumber) => {
        asked.push(pullRequestNumber);
        return {
          state: "closed",
          merged: false,
          mergeCommitSha: null,
          headSha: pullRequestNumber.toString().repeat(40).slice(0, 40),
        };
      },
    };

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileTerminalEntries(e, { repositoryId: REPO, baseRef: REF }, terminalReads, deps(1));
    }

    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await snapshot(e)).entries.every((entry) => entry.state === "Cancelled")).toBe(true);
    const projected = await readProjectedQueue(e.DB as unknown as D1Like, REPO, REF, {
      entriesPage: 1,
      transitionsPage: 1,
      pageSize: 20,
    });
    expect(projected?.entries).toEqual([]);
  });
});
