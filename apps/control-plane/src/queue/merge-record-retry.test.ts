import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { testD1 } from "../../test/d1.js";
import { queueRouteDeps, fixturePolicy } from "../../test/queue-deps.js";
import { acceptProof } from "../../test/proof.js";
import type { QueueRouteEnv } from "./routes.js";
import { queueRoutes, runOnQueue } from "./routes.js";
import { buildSnapshot, confirmOnly } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import { recordMergedTransition, type MergeLaneDeps } from "./merge-lane.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { mergeCommitText } from "./merge-commit.js";
import type { D1Like } from "./projection.js";
import { parseMergeIntent } from "@thwip/queue-protocol";

const REPO = "1315419165";
const REF = "refs/heads/main";
const BASE = "b".repeat(40);
const HEAD = "5".repeat(40);
const CANDIDATE = "c".repeat(40);
const TREE = "7".repeat(40);
const LANDED = "e".repeat(40);
const PR = 117;
const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let signingKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "merge-record-retry-test", alg: "ES256" };
});

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw.prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'acme')").run();
  raw
    .prepare("INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('proj_1', 'org_1', ?, 'acme/repo', 1)")
    .run(REPO);
  raw
    .prepare("INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES ('alice', 'org_1', '1', 'alice', datetime('now'))")
    .run();
  raw.prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?)").run(publicJwk.kid, JSON.stringify(publicJwk));
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const sign = async (_env: QueueRouteEnv, bytes: Uint8Array, typ: string) =>
  new CompactSign(bytes)
    .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid, typ })
    .sign(signingKey);

const onQueue = <T,>(
  e: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
  decide: Parameters<typeof runOnQueue<T>>[3],
) => runOnQueue(e, repositoryId, baseRef, decide);

function laneDeps(): MergeLaneDeps<QueueRouteEnv> {
  const fixture = queueRouteDeps({
    repositoryId: REPO,
    baseRef: REF,
    baseSha: BASE,
    treeOid: TREE,
    candidateSha: CANDIDATE,
    headShaFor: () => HEAD,
  }) as Parameters<typeof queueRoutes>[0];
  return {
    activePolicy: async () => fixturePolicy(),
    proofCheckRunId: async () => "778899",
    baseContainsSha: async () => true,
    signRecordBytes: sign,
    commitFacts: async (environment, repositoryId, sha) =>
      sha === LANDED
        ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "landed" }
        : fixture.commitFacts(environment, repositoryId, sha),
    mergeWrite: async () => ({ kind: "merged", mergeSha: LANDED }),
    sleep: async () => {},
  };
}

async function authorizeHeld(e: QueueRouteEnv): Promise<{
  release(): void;
  started: Promise<void>;
  finished: Promise<Record<string, unknown>>;
}> {
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const baseDeps = queueRouteDeps({
    repositoryId: REPO,
    baseRef: REF,
    baseSha: BASE,
    treeOid: TREE,
    candidateSha: CANDIDATE,
    headShaFor: () => HEAD,
  }) as Parameters<typeof queueRoutes>[0];
  const readFixtureCommit = baseDeps.commitFacts;
  const app = queueRoutes({
    ...baseDeps,
    queueProject: async () => ({ activationState: "enforced" }),
    activePolicy: async () => fixturePolicy(),
    signRecordBytes: sign,
    baseContainsSha: async () => true,
    commitFacts: async (environment, repositoryId, sha) =>
      sha === LANDED
        ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "landed" }
        : readFixtureCommit(environment, repositoryId, sha),
    pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
    mergeWrite: async () => {
      started();
      await wait;
      return { kind: "merged", mergeSha: LANDED };
    },
  });
  acceptProof(raw, REPO, HEAD);
  const finished = app
    .request(
      `/v1/queue/${REPO}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pullRequestNumber: PR,
          headSha: HEAD,
          baseRef: REF,
          authorGithubUserId: "1",
          draft: false,
        }),
      },
      e,
    )
    .then((response) => response.json() as Promise<Record<string, unknown>>);
  return { release, started: began, finished };
}

async function crossAttemptFixture(e: QueueRouteEnv): Promise<{
  held: Awaited<ReturnType<typeof authorizeHeld>>;
  normalAttempt: string;
  oldAttempt: string;
  repairDeps: RecordFromIntentDeps<QueueRouteEnv>;
}> {
  const held = await authorizeHeld(e);
  await held.started;
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  const normalAttempt = store.state().activeAttemptId!;
  const currentIntent = raw
    .prepare(
      "SELECT bytes FROM queue_attestations WHERE kind = 'merge-intent' AND attempt_id = ? LIMIT 1",
    )
    .get(normalAttempt) as { bytes: string } | undefined;
  if (currentIntent === undefined) throw new Error("the normal attempt has no signed intent");
  const parsedCurrent = parseMergeIntent(JSON.parse(currentIntent.bytes) as unknown);
  if (!parsedCurrent.ok || parsedCurrent.value.kind !== "reused") {
    throw new Error(parsedCurrent.ok ? "the live intent was not reused" : parsedCurrent.detail);
  }
  const current = parsedCurrent.value;
  if (!/^sha256:[0-9a-f]{64}$/.test(current.policyDigest)) {
    throw new Error(`unexpected live policy digest ${current.policyDigest}`);
  }
  const oldAttempt = "att_terminal_old";
  const oldOperation = `merge_${oldAttempt}`;
  const { signReusedIntent } = await import("./attestation.js");
  const signedOld = await signReusedIntent({
    operationId: oldOperation,
    attemptId: oldAttempt,
    git: current.git,
    position: {
      queueEpoch: current.queueEpoch,
      turnSequence: current.turnSequence,
      transitionSequence: current.transitionSequence,
      previousTransitionDigest: current.previousTransitionDigest,
    },
    pullRequestNumber: PR,
    evidence: {
      ...current.evidence,
      policyDigest: current.policyDigest,
      organizationId: "org_1",
    },
    mergeMethod: "merge",
    createdAt: "2026-08-12T00:00:00.000Z",
    signer: { sign: async (bytes, typ) => sign(e, bytes, typ) },
  });
  if ("error" in signedOld) throw new Error(signedOld.error);
  raw
    .prepare(
      "INSERT INTO queue_attestations (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws) VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?)",
    )
    .run(signedOld.digest, REPO, REF, oldAttempt, new TextDecoder().decode(signedOld.bytes), signedOld.jws);
  const oldMessage = mergeCommitText(PR, oldOperation).replace(/\n$/, "");
  const repairDeps: RecordFromIntentDeps<QueueRouteEnv> = {
    commitFacts: async (_environment, _repositoryId, sha) =>
      sha === LANDED
        ? { treeOid: TREE, parentShas: [BASE, HEAD], message: oldMessage }
        : { treeOid: TREE, parentShas: [], message: "base" },
    baseContainsSha: async () => true,
    pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
    activePolicy: async () => fixturePolicy(),
    signRecordBytes: sign,
    storeEvidence: async () => "no-bucket",
    onQueue,
  };
  return { held, normalAttempt, oldAttempt, repairDeps };
}

async function confirmedNormalRecordInput(e: QueueRouteEnv, attemptId: string) {
  const before = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  const beforeSnapshot = buildSnapshot(before.store);
  const { result: confirmation, snapshot } = await runOnQueue(e, REPO, REF, ({ commands, store }) =>
    confirmOnly(commands, store, {
      attemptId,
      operationId: `merge_${attemptId}`,
      mergeSha: LANDED,
      mergeTree: TREE,
      parentShas: [BASE, HEAD],
    }),
  );
  if (confirmation.confirmed.status === "rejected" || confirmation.attempt === null) {
    throw new Error(confirmation.confirmed.detail);
  }
  const entry = snapshot.entries.find((candidate) => candidate.entryId === confirmation.attempt?.entryId)!;
  return {
    repositoryId: REPO,
    baseRef: REF,
    attemptId,
    mergeSha: LANDED,
    mergeTree: TREE,
    parentShas: [BASE, HEAD],
    attempt: { ...confirmation.attempt },
    chainHead: confirmation.chainHead,
    queueEpoch: snapshot.queueEpoch,
    turnSequence: snapshot.turnSequence,
    pullRequestNumber: entry.pullRequestNumber,
    witnessPrincipalIds: ["alice"],
    beforeSnapshot,
  };
}

describe("exact merge-record failure and retry matrix", () => {
  it.each(["normal-post-store"] as const)("reuses staged bytes after %s failure", async () => {
    const e = env();
    const held = await authorizeHeld(e);
    await held.started;
    const before = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    const beforeSnapshot = buildSnapshot(before.store);
    const attemptId = beforeSnapshot.activeAttemptId!;
    const { result: confirmation, snapshot } = await runOnQueue(e, REPO, REF, ({ commands, store }) =>
      confirmOnly(commands, store, {
        attemptId,
        operationId: `merge_${attemptId}`,
        mergeSha: LANDED,
        mergeTree: TREE,
        parentShas: [BASE, HEAD],
      }),
    );
    if (confirmation.confirmed.status === "rejected" || confirmation.attempt === null) {
      throw new Error(confirmation.confirmed.detail);
    }
    const entry = snapshot.entries.find((candidate) => candidate.entryId === confirmation.attempt?.entryId)!;
    const attempt = confirmation.attempt;
    let failBeforeLink = true;
    const interruptedOnQueue = async <T,>(
      environment: QueueRouteEnv,
      repositoryId: string,
      baseRef: string,
      decide: Parameters<typeof runOnQueue<T>>[3],
    ) => {
      if (failBeforeLink) {
        failBeforeLink = false;
        throw new Error("injected normal stop before link");
      }
      return runOnQueue(environment, repositoryId, baseRef, decide);
    };
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      attemptId,
      mergeSha: LANDED,
      mergeTree: TREE,
      parentShas: [BASE, HEAD],
      attempt: {
        ...attempt,
      },
      chainHead: confirmation.chainHead,
      queueEpoch: snapshot.queueEpoch,
      turnSequence: snapshot.turnSequence,
      pullRequestNumber: entry.pullRequestNumber,
      witnessPrincipalIds: ["alice"],
    };
    await expect(recordMergedTransition(e, laneDeps(), { ...input, onQueue: interruptedOnQueue })).rejects.toThrow(
      /normal stop/i,
    );
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);

    const retry = await recordMergedTransition(e, laneDeps(), { ...input, onQueue });
    if (retry.sequence === null) throw new Error(retry.detail ?? "normal retry did not record");
    expect(retry).toMatchObject({ sequence: 1 });
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
    held.release();
    await held.finished;
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
  });

  it.each(["terminal-first-normal-second"] as const)("reuses one exact PR record for %s across attempts", async () => {
    const e = env();
    const { held, normalAttempt, oldAttempt, repairDeps } = await crossAttemptFixture(e);
    expect(
      await recordMergeFromIntent(e, repairDeps, {
        repositoryId: REPO,
        baseRef: REF,
        mergeSha: LANDED,
        witnessPrincipalId: "queue",
        reason: "terminal owner records first",
        attemptId: oldAttempt,
      }),
    ).toMatchObject({ status: "recorded", sequence: 1 });

    held.release();
    await held.finished;
    expect(normalAttempt).not.toBe(oldAttempt);
    const after = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(after.store.mergeOperations()).toContainEqual(
      expect.objectContaining({ attemptId: normalAttempt, outcome: "MERGED" }),
    );
    expect(buildSnapshot(after.store).entries[0]?.state).toBe("Merged");
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
  });

  it.each([
    { name: "terminal-stage then normal-link", first: "terminal" },
    { name: "normal-stage then terminal-link", first: "normal" },
  ] as const)("recovers one staged row across attempts: $name", async ({ first }) => {
    const e = env();
    const { held, normalAttempt, oldAttempt, repairDeps } = await crossAttemptFixture(e);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.release();
    };
    try {
      if (first === "terminal") {
        let interrupt = true;
        await expect(
          recordMergeFromIntent(
            e,
            {
              ...repairDeps,
              onQueue: async (environment, repositoryId, baseRef, decide) => {
                if (interrupt) {
                  interrupt = false;
                  throw new Error("injected terminal stop before link");
                }
                return onQueue(environment, repositoryId, baseRef, decide);
              },
            },
            {
              repositoryId: REPO,
              baseRef: REF,
              mergeSha: LANDED,
              witnessPrincipalId: "queue",
              reason: "terminal stages before normal callback",
              attemptId: oldAttempt,
            },
          ),
        ).rejects.toThrow(/terminal stop/i);
        expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(0);

        release();
        await held.finished;
      } else {
        const normalInput = await confirmedNormalRecordInput(e, normalAttempt);
        let interrupt = true;
        await expect(
          recordMergedTransition(e, laneDeps(), {
            ...normalInput,
            onQueue: async (environment, repositoryId, baseRef, decide) => {
              if (interrupt) {
                interrupt = false;
                throw new Error("injected normal stop before link");
              }
              return onQueue(environment, repositoryId, baseRef, decide);
            },
          }),
        ).rejects.toThrow(/normal stop/i);
        expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(0);

        expect(
          await recordMergeFromIntent(e, repairDeps, {
            repositoryId: REPO,
            baseRef: REF,
            mergeSha: LANDED,
            witnessPrincipalId: "queue",
            reason: "terminal recovers normal staged bytes",
            attemptId: oldAttempt,
          }),
        ).toMatchObject({ status: "recorded", sequence: 1 });
        release();
        await held.finished;
      }

      expect(normalAttempt).not.toBe(oldAttempt);
      expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
      expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
      expect(
        await recordMergeFromIntent(e, repairDeps, {
          repositoryId: REPO,
          baseRef: REF,
          mergeSha: LANDED,
          witnessPrincipalId: "queue",
          reason: "repeat recovery from the other attempt",
          attemptId: normalAttempt,
        }),
      ).toMatchObject({ status: "already" });
      expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
      expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
    } finally {
      release();
    }
  });
});
