import { afterEach, describe, expect, it } from "vitest";
import { parseQueueDecision, type QueueDecisionV1, type Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { evidenceKey, queueDecisionRecorder, type R2Like } from "./evidence-store.js";
import { buildSnapshot, commandsFor } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";

/**
 * The scheduling decision behind a turn, from the round that made it to the
 * assignment that binds it.
 *
 * Every offer used to carry a digest of all zeros, and the assignment parser
 * accepted it because it only reads the field's shape. So these tests never
 * assert that a digest is non-zero. They resolve it, hash the bytes back, and
 * put the record through the validator a device would use.
 */

const REPO = "1315419165";
const REF = "refs/heads/main";
const ORG = "org_1";
const HEAD = "e".repeat(40);
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const TREE = "7".repeat(40);
const DEVICE = `SHA256:${"a".repeat(43)}`;

const CARRIER =
  "v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlmUT09Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6ayIsInNpZyI6IkFBQUEifV19";

const open: Array<{ close(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

/** An R2 that keeps what it is given, so a digest can be resolved back. */
function bucket(): R2Like & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, value) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async head(key) {
      const found = objects.get(key);
      return found === undefined ? null : { size: found.byteLength };
    },
    async get(key) {
      const found = objects.get(key);
      return found === undefined
        ? null
        : { arrayBuffer: async () => found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength) as ArrayBuffer };
    },
  };
}

function env(): { e: QueueRouteEnv; db: D1Like; store: ReturnType<typeof bucket> } {
  const t = testD1();
  open.push(t);
  const raw = t.raw;
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(ORG, "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", ORG, REPO, "acme/repo");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES ('qp_1', ?, ?, ?, 1, 'enforced')`,
    )
    .run(ORG, REPO, REF);
  for (const [id, githubUserId] of [
    ["alice", "1"],
    ["bob", "2"],
  ]) {
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(id, ORG, githubUserId, id);
  }
  const store = bucket();
  return {
    e: { DB: t.db, EVIDENCE: store, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv,
    db: t.db as unknown as D1Like,
    store,
  };
}

/** Read a stored decision back the way an auditor would: by its digest alone. */
async function decisionAt(store: ReturnType<typeof bucket>, digest: string): Promise<QueueDecisionV1> {
  const key = evidenceKey({ organizationId: ORG, repositoryId: REPO, kind: "queue-decision", digest: digest as Sha256 });
  const object = await store.get(key);
  expect(object, `nothing is stored under ${digest}`).not.toBeNull();
  const bytes = new Uint8Array(await object!.arrayBuffer());
  // The name has to be the hash of the content, or the digest names something
  // other than what was read.
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(`sha256:${hex}`).toBe(digest);

  const parsed = parseQueueDecision(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.ok) throw new Error(`the stored decision is not valid: ${parsed.detail}`);
  return parsed.value;
}

function enqueue(
  commands: ReturnType<typeof commandsFor>,
  entryId: string,
  principal: string,
  githubUserId: string,
  pr: number,
): void {
  commands.requestQueue({
    idempotencyKey: `req-${entryId}`,
    entryId,
    pullRequestNumber: pr,
    sponsorPrincipalId: principal,
    sponsorGithubUserId: githubUserId,
    headSha: HEAD,
  });
  commands.evaluateReadiness({
    idempotencyKey: `ready-${entryId}`,
    entryId,
    ready: true,
    schedulerEligible: true,
    primaryReason: null,
  });
}

describe("the decision behind a turn", () => {
  it("stores a record the validator accepts, and binds its digest to the offer", async () => {
    const { e, db, store } = env();
    const recordDecision = queueDecisionRecorder({ db, bucket: store, repositoryId: REPO });

    const snapshot = await withQueueState(db, REPO, REF, async (s) => {
      const commands = commandsFor(s, undefined, recordDecision);
      enqueue(commands, "entry_1", "alice", "1", 82);
      await commands.tick({ idempotencyKey: "tick" });
      return buildSnapshot(s);
    });

    expect(snapshot.activeAttemptId).not.toBeNull();
    const digest = snapshot.activeDecisionDigest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const decision = await decisionAt(store, digest!);
    expect(decision).toMatchObject({
      algorithm: "principal-round-robin-v1",
      repositoryId: REPO,
      baseRef: REF,
      turnSequence: 1,
      selected: { entryId: "entry_1", pullRequestNumber: 82, sponsorPrincipalId: "alice" },
    });
    void e;
  });

  it("names the entry the scheduler actually selected, not the first one queued", async () => {
    const { db, store } = env();
    const recordDecision = queueDecisionRecorder({ db, bucket: store, repositoryId: REPO });

    // Alice takes and finishes the first turn, so bob is the principal served
    // least recently when the lane frees. A record built from anything other
    // than the round would still name alice's entry here.
    const first = await withQueueState(db, REPO, REF, async (s) => {
      const commands = commandsFor(s, undefined, recordDecision);
      enqueue(commands, "entry_alice", "alice", "1", 82);
      enqueue(commands, "entry_bob", "bob", "2", 83);
      await commands.tick({ idempotencyKey: "tick-1" });
      return buildSnapshot(s);
    });
    expect(first.activeEntryId).toBe("entry_alice");

    const second = await withQueueState(db, REPO, REF, async (s) => {
      const commands = commandsFor(s, undefined, recordDecision);
      commands.terminateAttempt({
        idempotencyKey: "give-up",
        attemptId: first.activeAttemptId!,
        outcome: "ADMIN_CANCELLED",
      });
      // Alice is ready again, so both principals compete in this round and the
      // record has to say why bob wins rather than only who won.
      commands.evaluateReadiness({
        idempotencyKey: "ready-again",
        entryId: "entry_alice",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
      await commands.tick({ idempotencyKey: "tick-2" });
      return buildSnapshot(s);
    });

    expect(second.activeEntryId).toBe("entry_bob");
    const decision = await decisionAt(store, second.activeDecisionDigest!);
    expect(decision.selected.entryId).toBe(second.activeEntryId);
    expect(decision.turnSequence).toBe(2);
    // The round is in the record: bob won because alice had been served and he
    // had not, and the validator has checked that claim against itself.
    expect(decision.eligiblePrincipalHeads.map((h) => h.sponsorPrincipalId)).toEqual(["bob", "alice"]);
    expect(decision.eligiblePrincipalHeads[0]).toMatchObject({ lastServedTurn: "0", oldestReadyEntryId: "entry_bob" });
    expect(decision.priorDecisionDigest).toBe(first.activeDecisionDigest);
  });

  it("gives a device an assignment bound to a decision it can fetch", async () => {
    const { e, db, store } = env();
    const signed: Uint8Array[] = [];
    const routes = queueRoutes({
      authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }),
      verifyOidc: async () => ({ repository_id: REPO }),
      pinnedVerifier: async () => null,
      activePolicy: async () => ({
        policyDigest: `sha256:${"a".repeat(64)}`,
        pipelineDigest: `sha256:${"b".repeat(64)}`,
        requiredSuites: ["lint"],
        securityProfile: "fresh",
        organizationId: ORG,
        verifier: null,
        document: { version: 1, securityProfile: "fresh", pipeline: { requiredSuites: ["lint"] } },
        version: 1,
        daggerModuleDigest: null,
        daggerEngineDigest: null,
      }),
      dispatchCandidateVerification: async () => ({ ok: true }),
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
      principalFor: async () => "alice",
      pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
      driveTurn: async () => {},
      commitFacts: async () => ({ treeOid: TREE, parentShas: [BASE], message: `feat: work\n\nthwip-proof: ${CARRIER}\n` }),
      integratedCandidate: async () => ({
        baseSha: BASE,
        headSha: HEAD,
        candidateSha: CANDIDATE,
        candidateTreeOid: TREE,
      }),
      proofCheckRunId: async () => "998877",
      signRecordBytes: async (_env, bytes) => {
        signed.push(bytes);
        return "eyJhbGciOiJFUzI1NiJ9.payload.signature";
      },
      baseContainsSha: async () => true,
    });

    const recordDecision = queueDecisionRecorder({ db, bucket: store, repositoryId: REPO });
    const held = await withQueueState(db, REPO, REF, async (s) => {
      const commands = commandsFor(s, undefined, recordDecision);
      enqueue(commands, "entry_1", "alice", "1", 82);
      await commands.tick({ idempotencyKey: "tick" });
      return buildSnapshot(s);
    });

    // The claim route refuses a machine the queue has not heard from, so the
    // device announces itself the way a real runner does.
    await routes.request(
      `/v1/queue/${REPO}/runners/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceKeyId: DEVICE }),
      },
      e,
    );

    const response = await routes.request(
      `/v1/queue/${REPO}/claim?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: held.activeAttemptId, deviceKeyId: DEVICE }),
      },
      e,
    );
    expect(response.status).toBe(200);

    const assignment = JSON.parse(new TextDecoder().decode(signed[0]!)) as {
      queue: { queueDecisionDigest: string; entryId: string; turnSequence: number };
    };
    // The assignment names a record that exists, says what this turn was, and
    // survives its own consistency checks.
    const decision = await decisionAt(store, assignment.queue.queueDecisionDigest);
    expect(decision.selected.entryId).toBe(assignment.queue.entryId);
    expect(decision.turnSequence).toBe(assignment.queue.turnSequence);

    // And the same record over the route a member reads it with, which is the
    // one place the validator runs against bytes nobody in this process built.
    const served = await routes.request(
      `/v1/queue/${REPO}/decisions/${assignment.queue.queueDecisionDigest}?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );
    expect(served.status).toBe(200);
    const body = (await served.json()) as { decision: QueueDecisionV1 };
    expect(body.decision).toEqual(decision);
  });

  it("refuses to serve a digest nothing was stored under", async () => {
    const { e, store } = env();
    const routes = queueRoutes({
      authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }),
      verifyOidc: async () => ({ repository_id: REPO }),
      pinnedVerifier: async () => null,
      activePolicy: async () => null,
      dispatchCandidateVerification: async () => ({ ok: true }),
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
      principalFor: async () => "alice",
      pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
      driveTurn: async () => {},
      commitFacts: async () => null,
      integratedCandidate: async () => null,
      proofCheckRunId: async () => null,
      signRecordBytes: async () => "",
      baseContainsSha: async () => true,
    });
    const response = await routes.request(
      `/v1/queue/${REPO}/decisions/sha256:${"0".repeat(64)}?ref=${encodeURIComponent(REF)}`,
      {},
      e,
    );
    expect(response.status).toBe(404);
    expect(store.objects.size).toBe(0);
  });
});
