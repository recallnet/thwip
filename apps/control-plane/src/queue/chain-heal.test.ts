import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import { signReusedIntent } from "./attestation.js";
import { applyHeal, type ApplyHealDeps, type HealPlan } from "./chain-heal.js";
import type { Sha256 } from "@thwip/queue-protocol";

/**
 * Answering a chain finding without letting anybody forge one.
 *
 * A `BASE_DISCONTINUITY` says the branch moved and no record accounts for the
 * movement. Turning that into a whole chain used to be forensics: read
 * `merge_operations` out of D1, list every signed merge intent for the
 * repository, ask GitHub for each commit in the gap, compare trees and parent
 * vectors by eye, decide which attempt authorized which commit, and call
 * `/repair` once per merge. The queue holds both halves of every one of those
 * comparisons, so it does the search itself.
 *
 * The search has three answers and these tests hold all three apart. One intent
 * authorizes the commit, so a merge record is written citing it. No intent
 * authorizes it, so the only true thing left is that the branch moved without
 * the queue certifying it, and that is what gets written. Two attempts
 * authorize it, so nothing is written and both are named.
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

/**
 * A real ES256 key, because the heal reads the chain the way an outside
 * verifier does and a stub signature would be reported as `BAD_SIGNATURE`
 * before any of these tests reached the finding they are about.
 */
let signingKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const REASON = "the heartbeat reported this gap";

/** The branch, oldest first: root, one recorded merge, then two that were not. */
const ROOT = { sha: "a0".repeat(20), tree: "a1".repeat(20), parents: ["a2".repeat(20)] };
const RECORDED = {
  attemptId: "att_recorded",
  pullRequestNumber: 90,
  baseSha: ROOT.sha,
  headSha: "b0".repeat(20),
  mergeSha: "b1".repeat(20),
  treeOid: "b2".repeat(20),
};
const AUTHORIZED = {
  attemptId: "att_authorized",
  pullRequestNumber: 91,
  baseSha: RECORDED.mergeSha,
  headSha: "c0".repeat(20),
  mergeSha: "c1".repeat(20),
  treeOid: "c2".repeat(20),
};
/**
 * The shape the four live merges have. The intent pins a base that had already
 * moved, so GitHub merged the head onto a different commit and produced a
 * different tree. The head matches; nothing else does.
 */
const UNAUTHORIZED = {
  attemptId: "att_unauthorized",
  pullRequestNumber: 92,
  /** Where the intent thought the branch was: one merge behind where it is. */
  staleBaseSha: RECORDED.mergeSha,
  headSha: "d0".repeat(20),
  mergeSha: "d1".repeat(20),
  landedTreeOid: "d2".repeat(20),
  pinnedTreeOid: "d3".repeat(20),
};

const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
  [ROOT.sha]: { treeOid: ROOT.tree, parentShas: ROOT.parents },
  [RECORDED.mergeSha]: { treeOid: RECORDED.treeOid, parentShas: [RECORDED.baseSha, RECORDED.headSha] },
  [AUTHORIZED.mergeSha]: { treeOid: AUTHORIZED.treeOid, parentShas: [AUTHORIZED.baseSha, AUTHORIZED.headSha] },
  [UNAUTHORIZED.mergeSha]: {
    treeOid: UNAUTHORIZED.landedTreeOid,
    parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
  },
};

function seed(): void {
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_acme", "10", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_acme", "org_acme", REPO, "acme/repo");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public, attested_from_sequence)
       VALUES (?, ?, ?, ?, 1, 'enforced', 1, 1)`,
    )
    .run("qp_acme", "org_acme", REPO, REF);
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("prn_acme", "org_acme", "11", "amelia");
  raw.prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?)").run("test-key", JSON.stringify(publicJwk));
}

/** Write a merge intent exactly as the authorize route writes it. */
async function seedIntent(merge: {
  attemptId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  treeOid: string;
  proofCheckRunId?: string;
}): Promise<string> {
  const signed = await signReusedIntent({
    operationId: `merge_${merge.attemptId}`,
    attemptId: merge.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: merge.baseSha,
      headRepositoryId: REPO,
      headSha: merge.headSha,
      candidateSha: "9f".repeat(20),
      candidateTreeOid: merge.treeOid,
      candidateParentOids: [merge.baseSha, merge.headSha],
    },
    position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: merge.pullRequestNumber,
    evidence: {
      workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
      organizationId: "org_acme",
      policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
      pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
      requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
      proofCheckRunId: merge.proofCheckRunId ?? "91289436271",
    },
    mergeMethod: "merge",
    createdAt: "2026-08-02T07:00:00.000Z",
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at)
       VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      signed.digest,
      REPO,
      REF,
      merge.attemptId,
      new TextDecoder().decode(signed.bytes),
      signed.jws,
      "2026-08-02T07:00:00.000Z",
    );
  return signed.digest;
}

function routes(isAdmin = true, over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId: "prn_acme", githubUserId: "11", isAdmin }),
    verifyOidc: async () => null,
    pinnedVerifier: async () => null,
    activePolicy: async () => ({
      policyDigest: `sha256:${"2".repeat(64)}`,
      pipelineDigest: `sha256:${"3".repeat(64)}`,
      requiredSuites: ["unit"],
      securityProfile: "fast",
      organizationId: "org_acme",
      verifier: null,
    }),
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async () => null,
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
    driveTurn: async () => {},
    commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
    baseContainsSha: async () => true,
    proofCheckRunId: async () => "91289436271",
    signRecordBytes: async (_e, bytes, typ) =>
      new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid: "test-key", typ }).sign(signingKey),
    ...over,
  });
}

type App = ReturnType<typeof routes>;

/** Put the one merge the chain does record in place, so a gap has a near end. */
async function seedRecordedMerge(app: App, e: QueueRouteEnv): Promise<void> {
  await seedIntent(RECORDED);
  const response = await app.request(
    `/v1/queue/${REPO}/repair?ref=${encodeURIComponent(REF)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeSha: RECORDED.mergeSha, reason: "seeding the chain" }),
    },
    e,
  );
  if (response.status !== 200) throw new Error(`seeding the chain failed: ${await response.text()}`);
}

/**
 * Make the chain report a gap.
 *
 * The verifier finds a discontinuity by comparing one record's `after` against
 * the next record's `before`, so a chain needs a record on the far side of the
 * unrecorded merges. This writes one for a merge that landed on top of them,
 * exactly as the live chain has: record 68 sits past the four missing merges
 * and says it began at a commit no record reached.
 */
async function seedRecordPastTheGap(app: App, e: QueueRouteEnv, beganAt: string): Promise<void> {
  const past = {
    attemptId: "att_past",
    pullRequestNumber: 99,
    baseSha: beganAt,
    headSha: "e0".repeat(20),
    mergeSha: "e1".repeat(20),
    treeOid: "e2".repeat(20),
  };
  COMMITS[past.mergeSha] = { treeOid: past.treeOid, parentShas: [past.baseSha, past.headSha] };
  await seedIntent(past);
  const response = await app.request(
    `/v1/queue/${REPO}/repair?ref=${encodeURIComponent(REF)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeSha: past.mergeSha, reason: "seeding past the gap" }),
    },
    e,
  );
  if (response.status !== 200) throw new Error(`seeding past the gap failed: ${await response.text()}`);
}

interface PlanShape {
  code: string;
  digest: string;
  summary: string;
  healable: boolean;
  steps: Array<{ action: string; commitSha: string; attemptIds?: string[]; sentence: string }>;
}

async function plans(app: App, e: QueueRouteEnv): Promise<PlanShape[]> {
  const response = await app.request(`/v1/queue/${REPO}/heal?ref=${encodeURIComponent(REF)}`, {}, e);
  expect(response.status).toBe(200);
  return ((await response.json()) as { findings: PlanShape[] }).findings;
}

function heal(app: App, e: QueueRouteEnv, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/v1/queue/${REPO}/heal?ref=${encodeURIComponent(REF)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

async function records(app: App, e: QueueRouteEnv): Promise<Array<Record<string, never> & { kind: string }>> {
  const response = await app.request(`/v1/queue/${REPO}/chain?ref=${encodeURIComponent(REF)}`, {}, e);
  const links = ((await response.json()) as { links: Array<{ record: string }> }).links;
  return links.map((l) => JSON.parse(l.record) as Record<string, never> & { kind: string });
}

describe("GET /v1/queue/:repositoryId/heal", () => {
  it("names the merge in a gap and the attempt that authorized it", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    const intentDigest = await seedIntent(AUTHORIZED);
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);

    const found = await plans(app, e);

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe("BASE_DISCONTINUITY");
    expect(found[0]?.healable).toBe(true);
    expect(found[0]?.steps).toEqual([
      {
        action: "record-merge",
        commitSha: AUTHORIZED.mergeSha,
        attemptId: AUTHORIZED.attemptId,
        pullRequestNumber: 91,
        intentDigest,
        sentence: expect.stringContaining("pull request 91"),
      },
    ]);
  });

  /**
   * The live case. Every one of the four merges stranded on 2 August 2026 has
   * an intent for its pull request and its head, and none of them pins the tree
   * GitHub produced or the parents it produced it over, because the base moved
   * between pinning and merging. No record may claim the queue authorized what
   * landed, so the plan offers the weaker true thing instead.
   */
  it("offers a movement record where the intent pinned a base that had moved", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedIntent({
      attemptId: UNAUTHORIZED.attemptId,
      pullRequestNumber: UNAUTHORIZED.pullRequestNumber,
      baseSha: UNAUTHORIZED.staleBaseSha,
      headSha: UNAUTHORIZED.headSha,
      treeOid: UNAUTHORIZED.pinnedTreeOid,
    });
    await seedRecordPastTheGap(app, e, UNAUTHORIZED.mergeSha);

    const found = await plans(app, e);

    expect(found[0]?.healable).toBe(true);
    expect(found[0]?.steps.map((s) => s.action)).toEqual(["record-merge", "record-movement"]);
    expect(found[0]?.steps[1]?.commitSha).toBe(UNAUTHORIZED.mergeSha);
    // The comparison that failed, said out loud, so the finding explains itself.
    expect(found[0]?.steps[1]?.sentence).toContain(UNAUTHORIZED.landedTreeOid);
    expect(found[0]?.steps[1]?.sentence).toContain(AUTHORIZED.mergeSha);
    expect(found[0]?.summary).toContain("weaker than a merge record");
  });

  it("refuses to choose where two attempts authorize one commit", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedIntent({ ...AUTHORIZED, attemptId: "att_rival" });
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);

    const found = await plans(app, e);

    expect(found[0]?.healable).toBe(false);
    expect(found[0]?.steps[0]?.action).toBe("ask-a-person");
    expect(found[0]?.steps[0]?.attemptIds).toEqual([AUTHORIZED.attemptId, "att_rival"]);
  });

  /**
   * One attempt re-signs its intent whenever a merge run restarts, so a commit
   * can have two intents that pin exactly its tree on exactly its parents and
   * disagree about something a record repeats. That is the opposite of nothing
   * having authorized the commit, and a movement record says the queue never
   * certified a movement two of its own signatures pin. Both digests are named
   * because the disagreement is between them and a person has to read both.
   */
  it("asks a person where one attempt's intents disagree about what they authorized", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    const first = await seedIntent(AUTHORIZED);
    const second = await seedIntent({ ...AUTHORIZED, proofCheckRunId: "91289436272" });
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);

    const found = await plans(app, e);

    expect(found[0]?.healable).toBe(false);
    expect(found[0]?.steps[0]?.action).toBe("ask-a-person");
    expect(found[0]?.steps[0]?.sentence).toContain(first);
    expect(found[0]?.steps[0]?.sentence).toContain(second);
  });

  it("is closed to anyone who is not a repository administrator", async () => {
    const e = env();
    seed();
    const app = routes(false);
    const response = await app.request(`/v1/queue/${REPO}/heal?ref=${encodeURIComponent(REF)}`, {}, e);
    expect(response.status).toBe(403);
  });
});

describe("POST /v1/queue/:repositoryId/heal", () => {
  it("records the authorized merge and closes the finding", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);
    const finding = (await plans(app, e))[0]!.digest;

    const response = await heal(app, e, { finding, reason: REASON });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      healed: "applied",
      wrote: [{ commitSha: AUTHORIZED.mergeSha, kind: "merge" }],
    });
    expect(await plans(app, e)).toEqual([]);
  });

  /**
   * The claim a movement record makes and the one it refuses to make. It says
   * the branch went from one commit to another and that the queue did not
   * certify the move. It does not name a pull request, an attempt, or a policy,
   * because no signed intent authorized this commit and inventing those would
   * be the forgery the whole design exists to prevent.
   */
  it("writes a movement record, not a merge record, where no intent authorizes the commit", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent({
      attemptId: UNAUTHORIZED.attemptId,
      pullRequestNumber: UNAUTHORIZED.pullRequestNumber,
      baseSha: UNAUTHORIZED.staleBaseSha,
      headSha: UNAUTHORIZED.headSha,
      treeOid: UNAUTHORIZED.pinnedTreeOid,
    });
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
    };
    await seedRecordPastTheGap(app, e, UNAUTHORIZED.mergeSha);
    const finding = (await plans(app, e))[0]!.digest;

    const response = await heal(app, e, { finding, reason: REASON });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      healed: "applied",
      wrote: [{ commitSha: UNAUTHORIZED.mergeSha, kind: "external-transition" }],
    });

    const written = (await records(app, e)).find((r) => r.kind === "external-transition") as unknown as {
      before: { baseSha: string };
      after: { baseSha: string; treeOid: string; parentOids: string[] };
      external: { observationReasonCode: string };
    };
    expect(written.before.baseSha).toBe(RECORDED.mergeSha);
    expect(written.after.baseSha).toBe(UNAUTHORIZED.mergeSha);
    expect(written.after.treeOid).toBe(UNAUTHORIZED.landedTreeOid);
    expect(written.after.parentOids).toEqual([RECORDED.mergeSha, UNAUTHORIZED.headSha]);
    expect(written.external.observationReasonCode).toBe("unknown_provider_movement");
    expect(await plans(app, e)).toEqual([]);

    // Restore the fixture the other tests share.
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
    };
  });

  it("writes nothing and names both attempts where two authorize one commit", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedIntent({ ...AUTHORIZED, attemptId: "att_rival" });
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);
    const before = await records(app, e);
    const finding = (await plans(app, e))[0]!.digest;

    const response = await heal(app, e, { finding, reason: REASON });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; detail?: string; error: string };
    expect(body.code).toBe("NOT_HEALABLE");
    expect(body.error).toContain("att_rival");
    expect(body.error).toContain(AUTHORIZED.attemptId);
    expect(await records(app, e)).toEqual(before);
  });

  /**
   * A commit that exists is not a commit that landed. The throwaway merge
   * GitHub computes for an open pull request has a real tree over real parents
   * and is on no branch, and record 54 is what recording one produces. The
   * movement path asks the branch the same question the repair path asks.
   */
  it("refuses to record a movement to a commit the branch does not contain", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedRecordPastTheGap(app, e, UNAUTHORIZED.mergeSha);
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
    };
    const finding = (await plans(app, e))[0]!.digest;
    const strict = routes(true, { baseContainsSha: async (_e, _r, _b, sha) => sha !== UNAUTHORIZED.mergeSha });

    const response = await heal(strict, e, { finding, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "MERGE_NOT_ON_BASE" });
    expect((await records(app, e)).some((r) => r.kind === "external-transition")).toBe(false);

    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
    };
  });

  /**
   * The sweep that settles stranded merge writes calls the repair path and
   * leaves the row alone when it refuses. A commit no intent authorizes refuses
   * forever, so the four writes stranded on 2 August 2026 would have been read
   * from GitHub every five minutes for the rest of the account's life, and the
   * heal that put them in the chain would have changed nothing about that.
   *
   * A chain that already carries a record for the commit has nothing left to
   * put back. That is not the operator's word for it: the record is signed, it
   * is in the chain, and the sweep confirmed the merge from GitHub before it got
   * here.
   */
  it("tells a caller a healed commit is already in the chain instead of refusing it", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedRecordPastTheGap(app, e, UNAUTHORIZED.mergeSha);
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
    };
    const finding = (await plans(app, e))[0]!.digest;
    await heal(app, e, { finding, reason: REASON });

    const response = await app.request(
      `/v1/queue/${REPO}/repair?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mergeSha: UNAUTHORIZED.mergeSha, reason: "the sweep asking again" }),
      },
      e,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: "already" });

    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
    };
  });

  it("writes nothing where one attempt's intents disagree", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedIntent({ ...AUTHORIZED, proofCheckRunId: "91289436272" });
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);
    const before = await records(app, e);
    const finding = (await plans(app, e))[0]!.digest;

    const response = await heal(app, e, { finding, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_HEALABLE" });
    expect(await records(app, e)).toEqual(before);
  });

  it("refuses a finding this branch's chain does not report", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);

    const response = await heal(app, e, { finding: `sha256:${"f".repeat(64)}`, reason: REASON });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NO_SUCH_FINDING" });
  });

  it("requires a reason", async () => {
    const e = env();
    seed();
    const app = routes();
    const response = await heal(app, e, { finding: `sha256:${"f".repeat(64)}`, reason: "short" });
    expect(response.status).toBe(400);
  });

  it("is closed to anyone who is not a repository administrator", async () => {
    const e = env();
    seed();
    const response = await heal(routes(false), e, { finding: `sha256:${"f".repeat(64)}`, reason: REASON });
    expect(response.status).toBe(403);
  });
});

/**
 * The invariant does not live in the planner alone.
 *
 * A movement record's whole claim is that no signed intent pins this commit.
 * The planner decides that, and a plan reaches `applyHeal` as data, so the
 * write itself asks the same question again against the same rows. Anything
 * that reaches this with a movement step for a pinned commit is wrong about
 * the commit, and signing it would put a false claim in an append-only chain.
 */
describe("applyHeal", () => {
  function applyDeps(): ApplyHealDeps<QueueRouteEnv> {
    return {
      commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
      baseContainsSha: async () => true,
      activePolicy: async () => ({
        policyDigest: `sha256:${"2".repeat(64)}`,
        pipelineDigest: `sha256:${"3".repeat(64)}`,
        requiredSuites: ["unit"],
        organizationId: "org_acme",
      }),
      signRecordBytes: async (_e, bytes, typ) =>
        new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid: "test-key", typ }).sign(signingKey),
      storeEvidence: async () => "no-bucket",
      onQueue: (e, repositoryId, baseRef, decide) => runOnQueue(e, repositoryId, baseRef, decide),
    };
  }

  it("refuses to record a movement for a commit a signed intent pins", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    const before = await records(app, e);
    const plan: HealPlan = {
      code: "BASE_DISCONTINUITY",
      sequence: 1,
      digest: `sha256:${"a".repeat(64)}`,
      detail: "the branch moved and no record accounts for it",
      summary: "recording this writes one movement",
      steps: [
        {
          action: "record-movement",
          commitSha: AUTHORIZED.mergeSha,
          sentence: "no signed intent pins this commit",
        },
      ],
      healable: true,
    };

    const outcome = await applyHeal(e, applyDeps(), {
      repositoryId: REPO,
      baseRef: REF,
      plan,
      actorPrincipalId: "prn_acme",
      reason: REASON,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "INTENT_PINS_COMMIT" });
    expect(await records(app, e)).toEqual(before);
  });
});
