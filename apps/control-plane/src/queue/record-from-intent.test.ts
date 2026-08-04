import { afterEach, describe, expect, it } from "vitest";
import type { Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import type { QueueRouteEnv } from "./routes.js";
import { runOnQueue } from "./routes.js";
import { signReusedIntent } from "./attestation.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";

/**
 * Direct tests of the function `POST /v1/queue/:repositoryId/repair` calls.
 * `chain-repair.test.ts` drives the same logic over HTTP and covers the
 * success paths; these cover refusals a caller can hit without a route in
 * front of it.
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

const FIRST = {
  attemptId: "att_first",
  pullRequestNumber: 96,
  baseSha: "a1".repeat(20),
  headSha: "b2".repeat(20),
  mergeSha: "c3".repeat(20),
  treeOid: "d4".repeat(20),
  beforeTree: "e5".repeat(20),
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

async function seedIntent(merge: typeof FIRST, candidateSha = "9f".repeat(20)): Promise<string> {
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
    createdAt: "2026-07-31T22:00:00.000Z",
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
      "2026-07-31T22:00:00.000Z",
    );
  return signed.digest;
}

/** What GitHub says about every commit these tests name. */
const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
  [FIRST.baseSha]: { treeOid: FIRST.beforeTree, parentShas: ["5c".repeat(20)] },
  [FIRST.mergeSha]: { treeOid: FIRST.treeOid, parentShas: [FIRST.baseSha, FIRST.headSha] },
};

const stubDeps: RecordFromIntentDeps<QueueRouteEnv> = {
  commitFacts: async (_env, _repositoryId, sha) => COMMITS[sha] ?? null,
  baseContainsSha: async () => true,
  activePolicy: async () => ({
    policyDigest: `sha256:${"2".repeat(64)}`,
    pipelineDigest: `sha256:${"3".repeat(64)}`,
    requiredSuites: ["unit"],
    organizationId: "org_acme",
  }),
  signRecordBytes: async () => "jws-record",
  storeEvidence: async () => "no-bucket",
  onQueue: (env, repositoryId, baseRef, decide) => runOnQueue(env, repositoryId, baseRef, decide),
};

describe("recordMergeFromIntent", () => {
  it("refuses a commit the base does not contain, because a record would claim the branch became it", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const deps = { ...stubDeps, baseContainsSha: async () => false };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prin_test",
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_ON_BASE" });
  });

  it("refuses when the base cannot be asked, because unknown is not permission", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const deps = { ...stubDeps, baseContainsSha: async () => null };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prin_test",
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_ON_BASE" });
  });

  /**
   * A chain has a beginning, and it moves. `attested_from_sequence` says which
   * link the current one starts at, and everything before it belongs to a
   * chain this branch no longer keeps. A record from back there naming the
   * commit would settle a write against a chain nobody verifies, so the merge
   * would read as recorded while the live chain never mentions it.
   *
   * The same attempt id is used on both sides of the epoch bump, because that
   * is the common case: an operator raises `attested_from_sequence` and the
   * attempt whose old record fell behind it is the same attempt asking to be
   * recorded again. `recordCoveringCommit` already excludes the dead-epoch
   * row by its digest; `transitionRecordFor` has to exclude it by attempt id
   * scoped the same way, or it hands back that row's digest as though it
   * still sat in the live chain.
   */
  it("does not let a record from a previous epoch stand in for one in this chain", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    raw
      .prepare("UPDATE queue_projects SET attested_from_sequence = 5 WHERE github_repository_id = ?")
      .run(REPO);
    raw
      .prepare(
        `INSERT INTO queue_attestations
           (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
         VALUES (?, 'transition-record', ?, ?, 2, ?, ?, ?)`,
      )
      .run(
        `sha256:${"c".repeat(64)}`,
        REPO,
        REF,
        FIRST.attemptId,
        JSON.stringify({ after: { baseSha: FIRST.mergeSha } }),
        "jws-old",
      );

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prin_test",
    });

    expect(outcome).toMatchObject({ status: "recorded", attemptId: FIRST.attemptId });
  });

  it("refuses a commit the queue never authorized", async () => {
    const e = env();
    seed();
    const forged = "7f".repeat(20);
    COMMITS[forged] = { treeOid: "80".repeat(20), parentShas: [FIRST.baseSha, FIRST.headSha] };

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: forged,
      witnessPrincipalId: "prin_test",
    });

    delete COMMITS[forged];
    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
  });
});
