import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { signReusedIntent } from "./attestation.js";
import type { Sha256 } from "@thwip/queue-protocol";

/**
 * Putting a merge back into the chain after the attempt that authorized it is
 * gone.
 *
 * Four merges landed and were never recorded. The queue read GitHub before
 * GitHub's read caught up with its own write, concluded the merge had not
 * happened, and terminated the attempt. `reconcile` is the repair tool and it
 * refuses unless an attempt still holds the lane, so by the time anyone looked
 * it answered 409: the one tool for the job could not be used for the one job
 * it exists for.
 *
 * What survives the attempt is the merge intent. It is signed, it is stored by
 * digest, and it names the base, the head, the tree the queue authorized, the
 * pull request, the policy and the evidence. That is everything a transition
 * record cites, which is why a merge can be recorded from it long after the
 * attempt is compacted away.
 *
 * The operator supplies one thing: a commit sha. Everything the record claims
 * is read from the commit or from the intent, so there is no field an operator
 * can fill in with something that did not happen.
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

/** Two merges that landed one after the other and neither was written down. */
const FIRST = {
  attemptId: "att_first",
  pullRequestNumber: 96,
  baseSha: "a1".repeat(20),
  headSha: "b2".repeat(20),
  mergeSha: "c3".repeat(20),
  treeOid: "d4".repeat(20),
  beforeTree: "e5".repeat(20),
};
const SECOND = {
  attemptId: "att_second",
  pullRequestNumber: 97,
  baseSha: FIRST.mergeSha,
  headSha: "f6".repeat(20),
  mergeSha: "07".repeat(20),
  treeOid: "18".repeat(20),
  beforeTree: FIRST.treeOid,
};

/** A commit on the branch the queue authorized nothing for. */
const UNAUTHORIZED = {
  mergeSha: "29".repeat(20),
  treeOid: "3a".repeat(20),
  parentShas: [SECOND.mergeSha, "4b".repeat(20)],
};

type Merge = typeof FIRST;

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
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public)
       VALUES (?, ?, ?, ?, 1, 'enforced', 1)`,
    )
    .run("qp_acme", "org_acme", REPO, REF);
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("prn_acme", "org_acme", "11", "amelia");
}

/**
 * Write the merge intent exactly as the authorize route writes it, so the
 * repair reads a real signed record rather than a fixture shaped to suit it.
 */
async function seedIntent(
  merge: Merge,
  candidateSha = "9f".repeat(20),
  createdAt = "2026-07-31T22:00:00.000Z",
): Promise<string> {
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
      candidateSha,
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
      proofCheckRunId: "91289436271",
    },
    mergeMethod: "merge",
    createdAt,
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at)
       VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(signed.digest, REPO, REF, merge.attemptId, new TextDecoder().decode(signed.bytes), signed.jws, createdAt);
  return signed.digest;
}

/** What GitHub says about every commit these tests name. */
const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
  [FIRST.baseSha]: { treeOid: FIRST.beforeTree, parentShas: ["5c".repeat(20)] },
  [FIRST.mergeSha]: { treeOid: FIRST.treeOid, parentShas: [FIRST.baseSha, FIRST.headSha] },
  [SECOND.mergeSha]: { treeOid: SECOND.treeOid, parentShas: [SECOND.baseSha, SECOND.headSha] },
  [UNAUTHORIZED.mergeSha]: { treeOid: UNAUTHORIZED.treeOid, parentShas: UNAUTHORIZED.parentShas },
};

function routes(isAdmin = true) {
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
    driveTurn: async () => {},
    commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
    proofCheckRunId: async () => "91289436271",
    signRecordBytes: async () => "jws-record",
  });
}

function repair(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/v1/queue/${REPO}/repair?ref=${encodeURIComponent(REF)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

async function chainLinks(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
): Promise<Array<{ digest: string; sequence: number; record: string }>> {
  const response = await app.request(`/v1/queue/${REPO}/chain?ref=${encodeURIComponent(REF)}`, {}, e);
  return ((await response.json()) as { links: Array<{ digest: string; sequence: number; record: string }> }).links;
}

const REASON = "pull request 96 is on main with no record";

describe("POST /v1/queue/:repositoryId/repair", () => {
  it("records a merge whose attempt no longer holds the lane", async () => {
    const e = env();
    seed();
    const intentDigest = await seedIntent(FIRST);
    const app = routes();

    const response = await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recorded: "applied",
      attemptId: FIRST.attemptId,
      pullRequestNumber: 96,
      sequence: 1,
      mergeIntentDigest: intentDigest,
    });
  });

  it("writes a record the chain serves and that cites the intent that authorized it", async () => {
    const e = env();
    seed();
    const intentDigest = await seedIntent(FIRST);
    const app = routes();

    await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });

    const links = await chainLinks(app, e);
    expect(links).toHaveLength(1);
    const record = JSON.parse(links[0]!.record) as {
      kind: string;
      before: { baseSha: string };
      after: { baseSha: string; treeOid: string; parentOids: string[] };
      reusedProof: { mergeIntentDigest: string; attemptId: string; pullRequestNumber: number };
    };
    expect(record.kind).toBe("reused-proof-merge");
    expect(record.before.baseSha).toBe(FIRST.baseSha);
    expect(record.after.baseSha).toBe(FIRST.mergeSha);
    expect(record.after.treeOid).toBe(FIRST.treeOid);
    expect(record.after.parentOids).toEqual([FIRST.baseSha, FIRST.headSha]);
    expect(record.reusedProof.mergeIntentDigest).toBe(intentDigest);
    expect(record.reusedProof.attemptId).toBe(FIRST.attemptId);
    expect(record.reusedProof.pullRequestNumber).toBe(96);
  });

  /**
   * The chain is hash-linked and append-only, so a repair lands at the head and
   * links the head, whatever order the merges landed in. Two repairs run
   * back to back have to chain to each other rather than both claiming the
   * position after the same link.
   */
  it("appends at the head, linking the record before it", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    await seedIntent(SECOND);
    const app = routes();

    await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });
    await repair(app, e, { mergeSha: SECOND.mergeSha, reason: REASON });

    const links = await chainLinks(app, e);
    expect(links.map((l) => l.sequence)).toEqual([1, 2]);
    const second = JSON.parse(links[1]!.record) as { previousTransitionDigest: string; transitionSequence: number };
    expect(second.previousTransitionDigest).toBe(links[0]!.digest);
    expect(second.transitionSequence).toBe(2);
  });

  /**
   * The safeguard that matters. A commit really on the branch, named by a
   * repository administrator, with no merge intent behind it: the queue never
   * authorized it, so no record may claim it did.
   */
  it("refuses a commit no merge intent authorizes, and writes nothing", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const app = routes();

    const response = await repair(app, e, { mergeSha: UNAUTHORIZED.mergeSha, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "MERGE_NOT_AUTHORIZED" });
    expect(await chainLinks(app, e)).toEqual([]);
  });

  /**
   * The tree is the thing the queue verified. A commit whose parents match an
   * authorization but whose tree does not is a different tree than the one that
   * passed, and §6.2 invariant 18 refuses it at merge time. The reducer cannot
   * refuse it here, because the attempt is gone, so this does.
   */
  it("refuses a commit whose tree is not the tree the queue authorized", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const app = routes();
    const forged = "5d".repeat(20);
    COMMITS[forged] = { treeOid: "6e".repeat(20), parentShas: [FIRST.baseSha, FIRST.headSha] };

    const response = await repair(app, e, { mergeSha: forged, reason: REASON });

    delete COMMITS[forged];
    expect(response.status).toBe(409);
    expect(await chainLinks(app, e)).toEqual([]);
  });

  /** The same intent, a commit built on a different base or a different head. */
  it("refuses a commit whose parents are not the base and head the queue authorized", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const app = routes();
    const forged = "7f".repeat(20);
    COMMITS[forged] = { treeOid: FIRST.treeOid, parentShas: [FIRST.baseSha, "80".repeat(20)] };

    const response = await repair(app, e, { mergeSha: forged, reason: REASON });

    delete COMMITS[forged];
    expect(response.status).toBe(409);
    expect(await chainLinks(app, e)).toEqual([]);
  });

  it("refuses a commit GitHub will not serve, rather than taking the operator's word", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const app = routes();

    const response = await repair(app, e, { mergeSha: "91".repeat(20), reason: REASON });

    expect(response.status).toBe(404);
    expect(await chainLinks(app, e)).toEqual([]);
  });

  it("is idempotent: a second repair of the same merge adds no second link", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const app = routes();

    const first = (await (await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON })).json()) as {
      transitionDigest: string;
    };
    const again = await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ recorded: "already", transitionDigest: first.transitionDigest });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  /**
   * One attempt can sign its intent more than once. The authorize route is
   * called again when a merge run restarts, and each call stamps a fresh
   * `createdAt`, so two rows end up authorizing the same commit for the same
   * attempt. Pull requests 103 and 105 on staging are both shaped like that.
   *
   * Nothing is ambiguous about that: the two intents pin the same tree on the
   * same parents for the same pull request under the same policy and the same
   * evidence. The record cites the first one, because it is the authorization
   * that was in force when the merge was asked for.
   */
  it("records a merge whose attempt signed its intent twice, citing the first", async () => {
    const e = env();
    seed();
    const earlier = await seedIntent(FIRST);
    const later = await seedIntent(FIRST, "a0".repeat(20), "2026-07-31T22:04:00.000Z");
    expect(later).not.toBe(earlier);
    const app = routes();

    const response = await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: "applied", mergeIntentDigest: earlier });
  });

  /**
   * Two different attempts on the same base and head do authorize the same
   * commit, and the record has to name one of them. Guessing would attribute a
   * merge to a turn that did not ask for it, so this asks.
   */
  it("refuses when two different attempts authorize the same commit", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    await seedIntent({ ...FIRST, attemptId: "att_retry" });
    const app = routes();

    const response = await repair(app, e, { mergeSha: FIRST.mergeSha, reason: REASON });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("att_retry") as unknown as string,
    });
    expect(await chainLinks(app, e)).toEqual([]);
  });

  it("names the attempt to settle which of two authorized the commit", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    await seedIntent({ ...FIRST, attemptId: "att_retry" });
    const app = routes();

    const response = await repair(app, e, {
      mergeSha: FIRST.mergeSha,
      reason: REASON,
      attemptId: "att_retry",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: "applied", attemptId: "att_retry" });
  });

  it("requires an administrator of the organization that owns the repository", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);

    const response = await repair(routes(false), e, { mergeSha: FIRST.mergeSha, reason: REASON });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "repository admin required" });
  });

  it("requires a reason", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);

    const response = await repair(routes(), e, { mergeSha: FIRST.mergeSha, reason: "short" });

    expect(response.status).toBe(400);
  });
});
