import { afterEach, describe, expect, it } from "vitest";
import { verifyChain, type Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { signReusedIntent } from "./attestation.js";

/**
 * Correcting a record that says something untrue, without rewriting history.
 *
 * Record 54 says pull request 107's merge left the base at
 * `ff6ea882feefd64c4e9f4dff909209e7adb281e3`, which is the test merge GitHub
 * computed while the pull request was still open. Main became
 * `0b2076107aa20f8b365d3b510de4838b05d12622`: same tree, same parents, same
 * order. The record cannot be edited, because six records chain from its digest,
 * so the correction is appended and the walk follows it in place of the original.
 *
 * The safety property is the whole design, so it is what most of this file
 * tests. A correction stands only where the record's own sha is one the base
 * branch does not contain, and only where the sha it names instead is on the
 * branch with that record's tree and that record's parents. GitHub answers both
 * questions; the operator answers neither.
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

const ATTEMPT = "att_4a68f77c-4257-4896-9ba1-2174ee4e9a9e";
const PRIOR = "a5f50bacb82ee5fc16de2efc73d320c7deff30fe";
const PRIOR_TREE = "87a2820524fe3020659eaee458e677d1391947cb";
const HEAD_107 = "8089c282d8d486af6e3b0465f7d2e0c6a4bde28b";
const TEST_MERGE = "ff6ea882feefd64c4e9f4dff909209e7adb281e3";
const REAL_MERGE = "0b2076107aa20f8b365d3b510de4838b05d12622";
const MERGE_TREE = "febb37430f3fd96c8b11e1b0f60ec0697b9f7cb6";

/** What GitHub says about each commit here. Both merges carry the same facts. */
const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
  [PRIOR]: { treeOid: PRIOR_TREE, parentShas: ["5c".repeat(20)] },
  [TEST_MERGE]: { treeOid: MERGE_TREE, parentShas: [PRIOR, HEAD_107] },
  [REAL_MERGE]: { treeOid: MERGE_TREE, parentShas: [PRIOR, HEAD_107] },
};

/** Only the real merge is on main. The test merge is on no branch and never was. */
const onMain = async (_e: unknown, _r: string, _ref: string, sha: string) => sha === REAL_MERGE;

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

async function seedIntent(): Promise<string> {
  const signed = await signReusedIntent({
    operationId: `merge_${ATTEMPT}`,
    attemptId: ATTEMPT,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: PRIOR,
      headRepositoryId: REPO,
      headSha: HEAD_107,
      candidateSha: TEST_MERGE,
      candidateTreeOid: MERGE_TREE,
      candidateParentOids: [PRIOR, HEAD_107],
    },
    position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: 107,
    evidence: {
      workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
      organizationId: "org_acme",
      policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
      pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
      requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
      proofCheckRunId: "91396799250",
    },
    mergeMethod: "merge",
    createdAt: "2026-08-01T17:29:00.000Z",
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
      ATTEMPT,
      new TextDecoder().decode(signed.bytes),
      signed.jws,
      "2026-08-01T17:29:00.000Z",
    );
  return signed.digest;
}

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId: "prn_acme", githubUserId: "11", isAdmin: true }),
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
    baseContainsSha: onMain,
    proofCheckRunId: async () => "91396799250",
    signRecordBytes: async () => "jws-record",
    ...over,
  });
}

function post(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/v1/queue/${REPO}/${path}?ref=${encodeURIComponent(REF)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

async function chainLinks(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
): Promise<Array<{ digest: string; sequence: number; record: string; jws: string }>> {
  const response = await app.request(`/v1/queue/${REPO}/chain?ref=${encodeURIComponent(REF)}`, {}, e);
  return (
    (await response.json()) as { links: Array<{ digest: string; sequence: number; record: string; jws: string }> }
  ).links;
}

/**
 * Put the wrong record on the chain the way it got there: through a path that
 * did not ask the branch whether it contained the sha.
 */
async function writeRecordFiftyFour(e: QueueRouteEnv): Promise<string> {
  const app = routes({ baseContainsSha: async () => true });
  const response = await post(app, e, "repair", { mergeSha: TEST_MERGE, reason: "before the invariant existed" });
  if (response.status !== 200) throw new Error(`seeding the wrong record failed: ${await response.text()}`);
  return ((await response.json()) as { transitionDigest: string }).transitionDigest;
}

const REASON = "record 54 names the test merge GitHub computed while pull request 107 was open";

describe("POST /v1/queue/:repositoryId/correct", () => {
  it("appends a correction naming the record it corrects and the sha that record should have named", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes();

    const response = await post(app, e, "correct", {
      transitionDigest: wrong,
      mergeSha: REAL_MERGE,
      reason: REASON,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      corrected: "applied",
      corrects: wrong,
      correctedBaseSha: TEST_MERGE,
      baseSha: REAL_MERGE,
      sequence: 2,
    });

    const links = await chainLinks(app, e);
    expect(links).toHaveLength(2);
    const record = JSON.parse(links[1]!.record) as {
      kind: string;
      before: { baseSha: string; treeOid: string };
      after: { baseSha: string; treeOid: string; parentOids: string[] };
      correction: { correctsTransitionDigest: string; correctedBaseSha: string; attemptId: string; reason: string };
    };
    expect(record.kind).toBe("base-correction");
    expect(record.before).toEqual({ baseSha: PRIOR, treeOid: PRIOR_TREE });
    expect(record.after.baseSha).toBe(REAL_MERGE);
    expect(record.after.treeOid).toBe(MERGE_TREE);
    expect(record.after.parentOids).toEqual([PRIOR, HEAD_107]);
    expect(record.correction.correctsTransitionDigest).toBe(wrong);
    expect(record.correction.correctedBaseSha).toBe(TEST_MERGE);
    expect(record.correction.attemptId).toBe(ATTEMPT);
    expect(record.correction.reason).toBe(REASON);
  });

  it("leaves the record it corrects exactly where it was, bytes and all", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const before = (await chainLinks(routes(), e))[0]!;
    const app = routes();

    await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: REASON });

    const after = (await chainLinks(app, e))[0]!;
    expect(after).toEqual(before);
    expect(JSON.parse(after.record).after.baseSha).toBe(TEST_MERGE);
  });

  it("makes the chain verify clean while it still carries the mistake", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes();

    await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: REASON });

    const links = await chainLinks(app, e);
    const encoder = new TextEncoder();
    const result = await verifyChain(
      links.map((l) => ({ digest: l.digest, sequence: l.sequence, jws: l.jws, bytes: encoder.encode(l.record) })),
      {
        verifySignature: async () => true,
        epochStartsAt: 1,
        subject: { repositoryId: REPO, baseRef: REF },
        head: { baseSha: REAL_MERGE },
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ from: TEST_MERGE, to: REAL_MERGE, correctsDigest: wrong });
  });

  /**
   * The test that matters most. A correction that can be applied to any record
   * is a licence to rewrite the past, which is worse than the bug it closes. So
   * the branch is asked about the sha the record names, and a record whose sha
   * the branch does contain is a record with nothing wrong with it.
   */
  it("refuses to correct a record whose base the branch does contain", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes({ baseContainsSha: async () => true });

    const response = await post(app, e, "correct", {
      transitionDigest: wrong,
      mergeSha: REAL_MERGE,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECORD_BASE_ON_BRANCH" });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  it("refuses when the branch cannot be asked what it contains", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes({ baseContainsSha: async () => null });

    const response = await post(app, e, "correct", {
      transitionDigest: wrong,
      mergeSha: REAL_MERGE,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECORD_BASE_UNREADABLE" });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  it("refuses a corrected sha the branch does not contain either", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes({ baseContainsSha: async () => false });

    const response = await post(app, e, "correct", {
      transitionDigest: wrong,
      mergeSha: REAL_MERGE,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "MERGE_NOT_ON_BASE" });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  /**
   * A correction substitutes one name for the same commit, not one commit for
   * another. The tree is what the queue verified, so a sha carrying a different
   * tree is a different merge and no correction can reach it.
   */
  it("refuses a sha whose tree is not the tree the record certified", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const other = "b".repeat(40);
    const app = routes({
      commitFacts: async (_e, _r, sha) =>
        sha === other ? { treeOid: "9".repeat(40), parentShas: [PRIOR, HEAD_107] } : (COMMITS[sha] ?? null),
      baseContainsSha: async (_e, _r, _ref, sha) => sha === other,
    });

    const response = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: other, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CORRECTION_NOT_THE_SAME_COMMIT" });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  it("refuses a sha whose parents are not the parents the record recorded", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const other = "b".repeat(40);
    const app = routes({
      commitFacts: async (_e, _r, sha) =>
        sha === other ? { treeOid: MERGE_TREE, parentShas: [PRIOR, "7".repeat(40)] } : (COMMITS[sha] ?? null),
      baseContainsSha: async (_e, _r, _ref, sha) => sha === other,
    });

    const response = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: other, reason: REASON });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CORRECTION_NOT_THE_SAME_COMMIT" });
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  it("refuses a digest this branch's chain does not serve", async () => {
    const e = env();
    seed();
    await seedIntent();
    await writeRecordFiftyFour(e);
    const app = routes();

    const response = await post(app, e, "correct", {
      transitionDigest: `sha256:${"f".repeat(64)}`,
      mergeSha: REAL_MERGE,
      reason: REASON,
    });

    expect(response.status).toBe(404);
    expect(await chainLinks(app, e)).toHaveLength(1);
  });

  it("is idempotent: correcting the same record twice adds no second link", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes();

    const first = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: REASON });
    const second = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: REASON });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ corrected: "already" });
    expect(await chainLinks(app, e)).toHaveLength(2);
  });

  it("requires an administrator of the organization that owns the repository", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes({
      authenticate: async () => ({ ok: true, principalId: "prn_acme", githubUserId: "11", isAdmin: false }),
    });

    const response = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: REASON });

    expect(response.status).toBe(403);
    expect(await chainLinks(routes(), e)).toHaveLength(1);
  });

  it("requires a reason", async () => {
    const e = env();
    seed();
    await seedIntent();
    const wrong = await writeRecordFiftyFour(e);
    const app = routes();

    const response = await post(app, e, "correct", { transitionDigest: wrong, mergeSha: REAL_MERGE, reason: "no" });

    expect(response.status).toBe(400);
    expect(await chainLinks(app, e)).toHaveLength(1);
  });
});
