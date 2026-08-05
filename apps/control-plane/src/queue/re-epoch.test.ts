import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { signReusedIntent } from "./attestation.js";

/**
 * Starting a repository's attested chain again, rather than repairing it.
 *
 * Every finding on this repository's chain came out of records written by
 * earlier versions of thwip: a link whose digest was a commit sha padded with
 * zeroes, an external transition the route could not serve, merges that landed
 * outside the lane, and records citing a check that ran against the pull request
 * head rather than the integrated candidate. None of it is worth surgery, and
 * healing a chain nobody is asked to trust repairs nothing.
 *
 * So the range a verifier checks starts again, past all of it, and a genesis is
 * written where it starts so the chain has a root rather than beginning mid-air.
 * Nothing is deleted: the old records stay signed and stay fetchable by digest,
 * and the storage chain runs unbroken across the boundary.
 *
 * The number that has to hold is `signaturesChecked`. An empty findings list
 * means nothing when the walk verified nothing, and an epoch past the end of the
 * chain produces exactly that.
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

let signingKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const REASON = "the early chain was written by software that no longer exists";

const ROOT = { sha: "a0".repeat(20), tree: "a1".repeat(20), parents: ["a2".repeat(20)] };
const OLD = {
  attemptId: "att_old",
  pullRequestNumber: 90,
  baseSha: ROOT.sha,
  headSha: "b0".repeat(20),
  mergeSha: "b1".repeat(20),
  treeOid: "b2".repeat(20),
};
/** Where the branch stands now, past everything the old range holds. */
const NOW = { sha: "e1".repeat(20), tree: "e2".repeat(20), parents: [OLD.mergeSha, "e3".repeat(20)] };

const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
  [ROOT.sha]: { treeOid: ROOT.tree, parentShas: ROOT.parents },
  [OLD.mergeSha]: { treeOid: OLD.treeOid, parentShas: [OLD.baseSha, OLD.headSha] },
  [NOW.sha]: { treeOid: NOW.tree, parentShas: NOW.parents },
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

async function seedIntent(): Promise<void> {
  const signed = await signReusedIntent({
    operationId: `merge_${OLD.attemptId}`,
    attemptId: OLD.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: OLD.baseSha,
      headRepositoryId: REPO,
      headSha: OLD.headSha,
      candidateSha: "9f".repeat(20),
      candidateTreeOid: OLD.treeOid,
      candidateParentOids: [OLD.baseSha, OLD.headSha],
    },
    position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: OLD.pullRequestNumber,
    evidence: {
      workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
      organizationId: "org_acme",
      policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
      pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
      requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
      proofCheckRunId: "91289436271",
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
      OLD.attemptId,
      new TextDecoder().decode(signed.bytes),
      signed.jws,
      "2026-08-02T07:00:00.000Z",
    );
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
    pullRequestPlacement: async () => ({
      authorGithubUserId: "1",
      baseRef: REF,
      authorIsBot: false,
      draft: false,
      headSha: OLD.headSha,
    }),
    commitFacts: async (_e, _r, sha) => COMMITS[sha] ?? null,
    baseContainsSha: async () => true,
    proofCheckRunId: async () => "91289436271",
    signRecordBytes: async (_e, bytes, typ) =>
      new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid: "test-key", typ }).sign(signingKey),
    ...over,
  });
}

type App = ReturnType<typeof routes>;

/** One record on the old range, so re-epoching has something to start past. */
async function seedOldRecord(app: App, e: QueueRouteEnv): Promise<string> {
  await seedIntent();
  const response = await app.request(
    `/v1/queue/${REPO}/repair?ref=${encodeURIComponent(REF)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeSha: OLD.mergeSha, reason: "seeding the old range" }),
    },
    e,
  );
  if (response.status !== 200) throw new Error(`seeding failed: ${await response.text()}`);
  return ((await response.json()) as { transitionDigest: string }).transitionDigest;
}

function reEpoch(app: App, e: QueueRouteEnv, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/v1/queue/${REPO}/re-epoch?ref=${encodeURIComponent(REF)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

async function chainLinks(
  app: App,
  e: QueueRouteEnv,
): Promise<Array<{ digest: string; sequence: number; record: string; jws: string }>> {
  const response = await app.request(`/v1/queue/${REPO}/chain?ref=${encodeURIComponent(REF)}`, {}, e);
  return (
    (await response.json()) as { links: Array<{ digest: string; sequence: number; record: string; jws: string }> }
  ).links;
}

describe("POST /v1/queue/:repositoryId/re-epoch", () => {
  it("opens the range at the next sequence and writes a root there", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedOldRecord(app, e);

    const response = await reEpoch(app, e, { atSha: NOW.sha, reason: REASON });

    const body = (await response.clone().json()) as { epochStartsAt: number; previousEpochStartedAt: number; genesis: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ epochStartsAt: 2, previousEpochStartedAt: 1 });

    const links = await chainLinks(app, e);
    expect(links.map((l) => l.sequence)).toEqual([2]);
    const record = JSON.parse(links[0]!.record) as { kind: string; after: { baseSha: string }; before: { baseSha: null } };
    expect(record.kind).toBe("genesis");
    expect(record.after.baseSha).toBe(NOW.sha);
    // A root starts from no base at all, which is what lets a walk begin here
    // without asking what came before.
    expect(record.before.baseSha).toBeNull();
  });

  it("verifies clean with every served link's signature checked", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedOldRecord(app, e);
    await reEpoch(app, e, { atSha: NOW.sha, reason: REASON });

    const links = await chainLinks(app, e);
    const encoder = new TextEncoder();
    const result = await verifyChain(
      links.map((l) => ({ digest: l.digest, sequence: l.sequence, jws: l.jws, bytes: encoder.encode(l.record) })),
      {
        verifySignature: async () => true,
        epochStartsAt: 2,
        subject: { repositoryId: REPO, baseRef: REF },
        head: { baseSha: NOW.sha },
      },
    );

    expect(result.findings).toEqual([]);
    // The number that makes the empty list mean something. An epoch past the end
    // of the chain would report no findings having checked nothing.
    expect(result.signaturesChecked).toBe(links.length);
    expect(result.signaturesChecked).toBeGreaterThan(0);
  });

  it("leaves the records below the range fetchable by digest", async () => {
    const e = env();
    seed();
    const app = routes();
    const old = await seedOldRecord(app, e);
    await reEpoch(app, e, { atSha: NOW.sha, reason: REASON });

    // Out of the chain a verifier walks, still in storage, still signed. Saying
    // the chain is attested from here does not make what came before unreadable.
    expect((await chainLinks(app, e)).some((l) => l.digest === old)).toBe(false);
    const response = await app.request(`/v1/queue/records/${old}`, {}, e);
    expect(response.status).toBe(200);
    expect((await response.json()) as { digest: string }).toMatchObject({ digest: old });
  });

  it("refuses a commit the branch does not contain", async () => {
    // The one gate that stops a range opening at a commit nobody merged. A
    // commit that exists is not a commit the branch stands at, and every record
    // after this one chains its base off whatever this names.
    const e = env();
    seed();
    const app = routes(true, { baseContainsSha: async () => false });
    await seedOldRecord(routes(), e);

    const response = await reEpoch(app, e, { atSha: NOW.sha, reason: REASON });

    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "COMMIT_NOT_ON_BASE" });
  });

  it("refuses anybody who is not a repository admin", async () => {
    const e = env();
    seed();
    await seedOldRecord(routes(), e);

    expect((await reEpoch(routes(false), e, { atSha: NOW.sha, reason: REASON })).status).toBe(403);
  });

  it("wants a reason, because a range that opened for no stated cause explains nothing later", async () => {
    const e = env();
    seed();
    const app = routes();
    await seedOldRecord(app, e);

    expect((await reEpoch(app, e, { atSha: NOW.sha, reason: "why" })).status).toBe(400);
    expect((await reEpoch(app, e, { reason: REASON })).status).toBe(400);
  });

  it("does not raise the epoch when the root could not be written", async () => {
    // Raising it first and then failing would serve a chain from a sequence with
    // nothing at it, which is the mid-air start the genesis exists to prevent.
    const e = env();
    seed();
    const app = routes(true, { commitFacts: async () => null });
    await seedOldRecord(routes(), e);

    expect((await reEpoch(app, e, { atSha: NOW.sha, reason: REASON })).status).toBe(409);
    const row = raw
      .prepare("SELECT attested_from_sequence AS epoch FROM queue_projects WHERE github_repository_id = ?")
      .get(REPO) as { epoch: number };
    expect(row.epoch).toBe(1);
  });
});
