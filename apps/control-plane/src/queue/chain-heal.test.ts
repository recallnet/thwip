import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import { signReusedIntent, signVerifiedIntent } from "./attestation.js";
import { applyHeal, type ApplyHealDeps, type HealPlan } from "./chain-heal.js";
import type { Sha256 } from "@thwip/queue-protocol";
import { mergeCommitText } from "./merge-commit.js";
import { withQueueState } from "./queue-state.js";
import { commandsFor } from "./queue-operations.js";
import type { D1Like } from "./projection.js";

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
 * These tests hold every answer that search can give apart. One intent
 * authorizes the commit, so a merge record is written citing it. No intent
 * authorizes it, so the only true thing left is that the branch moved without
 * the queue certifying it, and that is what gets written. Two attempts
 * authorize it, or one attempt's two intents disagree, or the intent is a kind
 * no record can be rebuilt from, so nothing is written and a person is told
 * what to look at.
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
  CONFIRMED_MERGES.clear();
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

const messageFor = (merge: { attemptId: string; pullRequestNumber: number }) =>
  mergeCommitText(merge.pullRequestNumber, `merge_${merge.attemptId}`);
const CONFIRMED_MERGES = new Map<number, string>();
const COMMITS: Record<string, { treeOid: string; parentShas: string[]; message: string }> = {
  [ROOT.sha]: { treeOid: ROOT.tree, parentShas: ROOT.parents, message: "root" },
  [RECORDED.mergeSha]: {
    treeOid: RECORDED.treeOid,
    parentShas: [RECORDED.baseSha, RECORDED.headSha],
    message: messageFor(RECORDED),
  },
  [AUTHORIZED.mergeSha]: {
    treeOid: AUTHORIZED.treeOid,
    parentShas: [AUTHORIZED.baseSha, AUTHORIZED.headSha],
    message: messageFor(AUTHORIZED),
  },
  [UNAUTHORIZED.mergeSha]: {
    treeOid: UNAUTHORIZED.landedTreeOid,
    parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
    message: messageFor(UNAUTHORIZED),
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
  mergeSha: string;
  treeOid: string;
  proofCheckRunId?: string;
  operationId?: string;
}): Promise<string> {
  const signed = await signReusedIntent({
    operationId: merge.operationId ?? `merge_${merge.attemptId}`,
    attemptId: merge.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: merge.baseSha,
      headRepositoryId: REPO,
      headSha: merge.headSha,
      candidateSha: merge.mergeSha,
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
  CONFIRMED_MERGES.set(merge.pullRequestNumber, merge.mergeSha);
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

/**
 * A verified merge's intent, which is signed the same way and cannot be
 * rebuilt from: its record binds the Actions run that verified the candidate
 * and the intent never carried one.
 */
async function seedVerifiedIntent(merge: {
  attemptId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  treeOid: string;
}): Promise<string> {
  const signed = await signVerifiedIntent({
    operationId: `merge_${merge.attemptId}`,
    attemptId: merge.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: merge.baseSha,
      headRepositoryId: REPO,
      headSha: merge.headSha,
      candidateSha: merge.mergeSha,
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
      assignmentDigest: `sha256:${"5".repeat(64)}` as Sha256,
      integrationEvidenceDigest: `sha256:${"6".repeat(64)}` as Sha256,
      execution: {
        ranOn: "github-actions",
        verifierResultDigest: `sha256:${"7".repeat(64)}` as Sha256,
        checkRunId: "91289436271",
        actionRunId: "17364817263",
      },
    },
    mergeMethod: "merge",
    createdAt: "2026-08-02T07:00:00.000Z",
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  CONFIRMED_MERGES.set(merge.pullRequestNumber, merge.mergeSha);
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
    queueProject: async () => ({ activationState: "enforced" }),
    principalFor: async () => null,
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
    commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
    baseContainsSha: async () => true,
    pullRequestMergeState: async (_e, _r, pullRequestNumber) => ({
      merged: CONFIRMED_MERGES.has(pullRequestNumber),
      mergeCommitSha: CONFIRMED_MERGES.get(pullRequestNumber) ?? null,
    }),
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
  COMMITS[past.mergeSha] = {
    treeOid: past.treeOid,
    parentShas: [past.baseSha, past.headSha],
    message: messageFor(past),
  };
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
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "BASE_DISCONTINUITY", ...body }),
    },
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
      mergeSha: UNAUTHORIZED.mergeSha,
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
    await seedIntent({
      ...AUTHORIZED,
      attemptId: "att_rival",
      operationId: `merge_${AUTHORIZED.attemptId}`,
    });
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

  /**
   * The panel must not offer a control that answers 409. A verified merge's
   * record binds the Actions run that verified the candidate and an override's
   * binds an authorization nothing may reissue, so neither can be rebuilt from
   * the intent, and the write path has always refused both. The plan says so
   * before an administrator presses anything.
   */
  it("offers no button for a merge whose record cannot be rebuilt from its intent", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedVerifiedIntent(AUTHORIZED);
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);

    const found = await plans(app, e);

    expect(found[0]?.healable).toBe(false);
    expect(found[0]?.steps[0]?.action).toBe("ask-a-person");
    expect(found[0]?.steps[0]?.commitSha).toBe(AUTHORIZED.mergeSha);
    expect(found[0]?.summary).toContain("verifier result");
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
      mergeSha: UNAUTHORIZED.mergeSha,
      treeOid: UNAUTHORIZED.pinnedTreeOid,
    });
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
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
      message: messageFor(UNAUTHORIZED),
    };
  });

  it("writes nothing and names both attempts where two authorize one commit", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedIntent({
      ...AUTHORIZED,
      attemptId: "att_rival",
      operationId: `merge_${AUTHORIZED.attemptId}`,
    });
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
      message: messageFor(UNAUTHORIZED),
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
      message: messageFor(UNAUTHORIZED),
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
      message: messageFor(UNAUTHORIZED),
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
      message: messageFor(UNAUTHORIZED),
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

  /**
   * Steps run oldest first and the first refusal stops the run, so a gap whose
   * second merge cannot be rebuilt would have written the first record and then
   * answered 409, leaving an administrator with an error beside a chain that
   * changed. The plan is unhealable as a whole, so nothing is written.
   */
  it("writes nothing where one merge in a gap cannot be rebuilt from its intent", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    const verified = {
      attemptId: "att_verified",
      pullRequestNumber: 93,
      baseSha: AUTHORIZED.mergeSha,
      headSha: "f0".repeat(20),
      mergeSha: "f1".repeat(20),
      treeOid: "f2".repeat(20),
    };
    COMMITS[verified.mergeSha] = {
      treeOid: verified.treeOid,
      parentShas: [verified.baseSha, verified.headSha],
      message: messageFor(verified),
    };
    await seedVerifiedIntent(verified);
    await seedRecordPastTheGap(app, e, verified.mergeSha);
    const before = await records(app, e);
    const found = (await plans(app, e))[0]!;

    expect(found.steps.map((s) => s.action)).toEqual(["record-merge", "ask-a-person"]);
    const response = await heal(app, e, { finding: found.digest, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_HEALABLE" });
    expect(await records(app, e)).toEqual(before);
  });

  /**
   * A button gets pressed twice. The chain is append-only, so a second write
   * for one finding is a second permanent claim about the same movement, and
   * nothing about the request tells the second POST that the first happened.
   * This test holds every guard that keeps it to one record. The plan is
   * recomputed from a fresh verification, so the answered finding is gone by
   * the second call. The movement carries a key unique to its commit, so the
   * index refuses a second row even if the plan were stale. The chain is
   * read back afterward to prove both held.
   */
  it("writes one record for one finding however many times it is pressed", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent({
      attemptId: UNAUTHORIZED.attemptId,
      pullRequestNumber: UNAUTHORIZED.pullRequestNumber,
      baseSha: UNAUTHORIZED.staleBaseSha,
      headSha: UNAUTHORIZED.headSha,
      mergeSha: UNAUTHORIZED.mergeSha,
      treeOid: UNAUTHORIZED.pinnedTreeOid,
    });
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
    };
    await seedRecordPastTheGap(app, e, UNAUTHORIZED.mergeSha);
    const finding = (await plans(app, e))[0]!.digest;

    const first = await heal(app, e, { finding, reason: REASON });
    const second = await heal(app, e, { finding, reason: REASON });

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect((await records(app, e)).filter((r) => r.kind === "external-transition")).toHaveLength(1);

    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
    };
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

  /**
   * A digest names the record a finding was reported at, and one record can be
   * reported at for more than one reason, so the digest alone does not name the
   * finding. Answering a finding thwip did not compute a plan for would carry
   * out a remedy for a different problem against a chain that keeps it.
   */
  it("refuses a finding whose code is not the one reported at that digest", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    await seedIntent(AUTHORIZED);
    await seedRecordPastTheGap(app, e, AUTHORIZED.mergeSha);
    const before = await records(app, e);
    const finding = (await plans(app, e))[0]!.digest;

    const response = await heal(app, e, { finding, code: "BROKEN_LINK", reason: REASON });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NO_SUCH_FINDING" });
    expect(await records(app, e)).toEqual(before);
  });

  it("requires the finding's code, because a digest alone does not name one", async () => {
    const e = env();
    seed();
    const app = routes();
    const response = await app.request(
      `/v1/queue/${REPO}/heal?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finding: `sha256:${"f".repeat(64)}`, reason: REASON }),
      },
      e,
    );
    expect(response.status).toBe(400);
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
  function applyDeps(over: Partial<ApplyHealDeps<QueueRouteEnv>> = {}): ApplyHealDeps<QueueRouteEnv> {
    return {
      commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
      baseContainsSha: async () => true,
      pullRequestMergeState: async (_e, _r, pullRequestNumber) => ({
        merged: CONFIRMED_MERGES.has(pullRequestNumber),
        mergeCommitSha: CONFIRMED_MERGES.get(pullRequestNumber) ?? null,
      }),
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
      ...over,
    };
  }

  function movementPlan(): HealPlan {
    return {
      code: "BASE_DISCONTINUITY",
      sequence: 1,
      digest: `sha256:${"a".repeat(64)}`,
      detail: "the branch moved and no record accounts for it",
      summary: "recording this writes one movement",
      steps: [
        {
          action: "record-movement",
          commitSha: UNAUTHORIZED.mergeSha,
          sentence: "no signed intent pins this commit",
        },
      ],
      healable: true,
    };
  }

  function movementInput() {
    return {
      repositoryId: REPO,
      baseRef: REF,
      plan: movementPlan(),
      actorPrincipalId: "prn_acme",
      reason: REASON,
    };
  }

  function makeMovementCommit(): void {
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
    };
  }

  /**
   * A repeat says where the record is, not where it would have gone.
   *
   * The second run finds the movement already in the chain and answers without
   * writing. It used to answer `sequence: 0`, a position no record holds, and
   * an operator reading it back would go looking at the start of a chain for a
   * record sitting at the end.
   */
  it("reports the position the record actually holds when it is already there", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedRecordedMerge(app, e);
    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [RECORDED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
    };
    const plan: HealPlan = {
      code: "BASE_DISCONTINUITY",
      sequence: 1,
      digest: `sha256:${"a".repeat(64)}`,
      detail: "the branch moved and no record accounts for it",
      summary: "recording this writes one movement",
      steps: [
        {
          action: "record-movement",
          commitSha: UNAUTHORIZED.mergeSha,
          sentence: "no signed intent pins this commit",
        },
      ],
      healable: true,
    };
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      plan,
      actorPrincipalId: "prn_acme",
      reason: REASON,
    };

    const first = await applyHeal(e, applyDeps(), input);
    const again = await applyHeal(e, applyDeps(), input);

    expect(first).toMatchObject({ status: "healed" });
    expect(again).toEqual(first);
    expect((await records(app, e)).filter((r) => r.kind === "external-transition")).toHaveLength(1);

    COMMITS[UNAUTHORIZED.mergeSha] = {
      treeOid: UNAUTHORIZED.landedTreeOid,
      parentShas: [AUTHORIZED.mergeSha, UNAUTHORIZED.headSha],
      message: messageFor(UNAUTHORIZED),
    };
  });

  it("does not report healed when the queue rejects the movement link", async () => {
    const e = env();
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    const deps = applyDeps({
      onQueue: (env, repositoryId, baseRef, decide) =>
        runOnQueue(env, repositoryId, baseRef, ({ store, commands }) => {
          Object.defineProperty(commands, "recordTransition", {
            value: () => ({ status: "rejected", detail: "injected movement link rejection" }),
          });
          return decide({ store, commands });
        }),
    });

    const outcome = await applyHeal(e, deps, movementInput());

    expect(outcome).toMatchObject({ status: "refused", code: "CHAIN_MOVED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/injected movement link rejection/i);
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE kind = 'external-transition'").all(),
    ).toEqual([{ sequence: null }]);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toEqual([]);
  });

  it("retries after the signed movement is stored but the queue link is not attempted", async () => {
    const e = env();
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    let stopBeforeLink = true;
    const deps = applyDeps({
      onQueue: async (...args) => {
        if (stopBeforeLink) {
          stopBeforeLink = false;
          throw new Error("injected stop before movement link");
        }
        return runOnQueue(...args);
      },
    });

    await expect(applyHeal(e, deps, movementInput())).rejects.toThrow(/before movement link/i);
    const staged = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind = 'external-transition'")
      .get() as { digest: string };
    const retry = await applyHeal(e, applyDeps(), movementInput());

    expect(retry).toMatchObject({ status: "healed" });
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toEqual([
      { digest: staged.digest },
    ]);
    expect(
      raw
        .prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE kind = 'external-transition' ORDER BY created_at")
        .all(),
    ).toEqual([{ sequence: 2 }]);
  });

  it("promotes a movement link left durable before its attestation placement", async () => {
    const e = env();
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    const deps = applyDeps({
      onQueue: async (...args) => {
        await runOnQueue(...args);
        throw new Error("injected stop after movement link");
      },
    });

    await expect(applyHeal(e, deps, movementInput())).rejects.toThrow(/after movement link/i);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toHaveLength(1);
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE kind = 'external-transition'").get(),
    ).toEqual({ sequence: null });

    const retry = await applyHeal(e, applyDeps(), movementInput());
    expect(retry).toMatchObject({ status: "healed", wrote: [{ sequence: 2 }] });
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE kind = 'external-transition'").get(),
    ).toEqual({ sequence: 2 });
  });

  it("recovers when queue state commits the movement before its durable projection", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    const rejecting = applyDeps({
      onQueue: (env, repositoryId, baseRef, decide) =>
        runOnQueue(env, repositoryId, baseRef, ({ store, commands }) => {
          Object.defineProperty(commands, "recordTransition", {
            value: () => ({ status: "rejected", detail: "stage without link" }),
          });
          return decide({ store, commands });
        }),
    });
    await applyHeal(e, rejecting, movementInput());
    const staged = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind = 'external-transition'")
      .get() as { digest: string };

    // This is the exact runOnQueue interleaving: queue_state committed the
    // append, but projectQueueState has not yet written queue_transitions_index.
    await withQueueState(db, REPO, REF, (store) => {
      const tail = store.state().transitions.at(-1);
      return commandsFor(store).recordTransition({
        idempotencyKey: `heal:${UNAUTHORIZED.mergeSha}`,
        kind: "external",
        transitionSequence: (tail?.transitionSequence ?? 0) + 1,
        priorDigest: tail?.digest ?? null,
        digest: staged.digest,
        baseSha: UNAUTHORIZED.mergeSha,
        attemptId: null,
        witnessPrincipalIds: ["prn_acme"],
      });
    });
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toEqual([]);

    const retry = await applyHeal(e, applyDeps(), movementInput());

    expect(retry).toMatchObject({ status: "healed", wrote: [{ sequence: 2 }] });
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toEqual([
      { digest: staged.digest },
    ]);
    expect(
      raw.prepare("SELECT transition_sequence AS sequence, attempt_id AS attemptId FROM queue_attestations WHERE digest = ?").get(staged.digest),
    ).toEqual({ sequence: 2, attemptId: `movement:${UNAUTHORIZED.mergeSha}` });
  });

  it("quarantines an unlinked staged movement after the head advances, then retries", async () => {
    const e = env();
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    const fillerDigest = `sha256:${"f".repeat(64)}`;
    let advanceHead = true;
    const moving = applyDeps({
      onQueue: async (env, repositoryId, baseRef, decide) => {
        if (advanceHead) {
          advanceHead = false;
          await runOnQueue(env, repositoryId, baseRef, ({ store, commands }) => {
            const tail = store.state().transitions.at(-1);
            return commands.recordTransition({
              idempotencyKey: "advance-before-movement-cas",
              kind: "external",
              transitionSequence: (tail?.transitionSequence ?? 0) + 1,
              priorDigest: tail?.digest ?? null,
              digest: fillerDigest,
              baseSha: "f0".repeat(20),
              attemptId: null,
              witnessPrincipalIds: ["prn_other"],
            });
          });
        }
        return runOnQueue(env, repositoryId, baseRef, decide);
      },
    });

    const first = await applyHeal(e, moving, movementInput());
    expect(first).toMatchObject({ status: "refused", code: "CHAIN_MOVED" });
    const stale = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind = 'external-transition'")
      .get() as { digest: string };

    const retry = await applyHeal(e, applyDeps(), movementInput());

    expect(retry).toMatchObject({ status: "healed", wrote: [{ sequence: 3 }] });
    expect(
      raw.prepare("SELECT transition_sequence AS sequence, attempt_id AS attemptId FROM queue_attestations WHERE digest = ?").get(stale.digest),
    ).toEqual({ sequence: null, attemptId: null });
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external' ORDER BY transition_sequence").all()).toHaveLength(2);
  });

  it("recovers a legacy positioned movement with no durable link on retry", async () => {
    const e = env();
    seed();
    await seedRecordedMerge(routes(), e);
    makeMovementCommit();
    const rejecting = applyDeps({
      onQueue: (env, repositoryId, baseRef, decide) =>
        runOnQueue(env, repositoryId, baseRef, ({ store, commands }) => {
          Object.defineProperty(commands, "recordTransition", {
            value: () => ({ status: "rejected", detail: "seed unlinked movement" }),
          });
          return decide({ store, commands });
        }),
    });
    await applyHeal(e, rejecting, movementInput());
    const legacy = raw
      .prepare("SELECT digest FROM queue_attestations WHERE kind = 'external-transition'")
      .get() as { digest: string };
    raw.prepare("UPDATE queue_attestations SET transition_sequence = 2 WHERE digest = ?").run(legacy.digest);

    const retry = await applyHeal(e, applyDeps(), movementInput());

    expect(retry).toMatchObject({ status: "healed", wrote: [{ sequence: 2 }] });
    expect(
      raw.prepare("SELECT transition_sequence AS sequence, attempt_id AS attemptId FROM queue_attestations WHERE digest = ?").get(legacy.digest),
    ).toEqual({ sequence: 2, attemptId: `movement:${UNAUTHORIZED.mergeSha}` });
    expect(raw.prepare("SELECT digest FROM queue_transitions_index WHERE kind = 'external'").all()).toEqual([
      { digest: legacy.digest },
    ]);
  });

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
