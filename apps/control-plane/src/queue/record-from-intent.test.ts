import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import {
  canonicalRecordBytes,
  envelopeDigest,
  parseIntegrationAssignment,
  recordDigest,
  requiredSuitesDigest,
  type Sha256,
} from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import type { QueueRouteEnv } from "./routes.js";
import { runOnQueue } from "./routes.js";
import { durableTransitionForAttempt, signReusedIntent, signVerifiedIntent } from "./attestation.js";
import { readQueue, recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { signLocalRunAssignment } from "./assignment.js";
import { integrationReceiptDigest } from "./integration-receipt.js";
import { mergeCommitText } from "./merge-commit.js";
import type { D1Like } from "./projection.js";

/**
 * Direct tests of the function `POST /v1/queue/:repositoryId/repair` calls.
 * `chain-repair.test.ts` drives the same logic over HTTP and covers the
 * success paths; these cover refusals a caller can hit without a route in
 * front of it.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let signingKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "record-from-intent-test", alg: "ES256" };
});

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw.prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?)").run(publicJwk.kid, JSON.stringify(publicJwk));
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;

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
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, chain_public, project_id)
       VALUES (?, ?, ?, ?, 1, 'enforced', 1, ?)`,
    )
    .run("qp_acme", "org_acme", REPO, REF, "proj_acme");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("prn_acme", "org_acme", "11", "amelia");
}

async function seedIntent(merge: typeof FIRST, candidateSha = merge.mergeSha): Promise<string> {
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
         (digest, kind, github_repository_id, project_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at)
       VALUES (?, 'merge-intent', ?, 'proj_acme', ?, NULL, ?, ?, ?, ?)`,
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

/** A real signed local assignment, accepted receipt and verified merge intent. */
async function seedVerifiedIntent(
  options: {
    acceptReceipt?: boolean;
    rowAssignmentId?: string;
    assignmentGit?: Partial<{
      objectFormat: "sha1" | "sha256";
      repositoryId: string;
      baseRef: string;
      baseSha: string;
      headRepositoryId: string;
      headSha: string;
      candidateParentOids: string[];
    }>;
    candidateSha?: string;
    intentCandidateSha?: string;
  } = {},
): Promise<string> {
  const candidateSha = options.candidateSha ?? FIRST.mergeSha;
  const assignmentId = `asg_${FIRST.attemptId}`;
  const rowAssignmentId = options.rowAssignmentId ?? assignmentId;
  const deviceKeyId = "SHA256:test-device";
  const requiredSuites = ["lint", "test"];
  const policyDocument = { schemaVersion: "1", securityProfile: "fresh", pipeline: { requiredSuites } };
  const policyDigest = await recordDigest(policyDocument);
  const assignment = await signLocalRunAssignment({
    assignmentId,
    attemptId: FIRST.attemptId,
    ownerId: "10",
    git: {
      objectFormat: options.assignmentGit?.objectFormat ?? "sha1",
      repositoryId: options.assignmentGit?.repositoryId ?? REPO,
      baseRef: options.assignmentGit?.baseRef ?? REF,
      baseSha: options.assignmentGit?.baseSha ?? FIRST.baseSha,
      headRepositoryId: options.assignmentGit?.headRepositoryId ?? REPO,
      headSha: options.assignmentGit?.headSha ?? FIRST.headSha,
      candidateSha,
      candidateTreeOid: FIRST.treeOid,
      candidateParentOids: options.assignmentGit?.candidateParentOids ?? [FIRST.baseSha, FIRST.headSha],
    },
    queue: {
      queueEpoch: 0,
      turnSequence: 13,
      entryId: `entry_${REPO}_${FIRST.pullRequestNumber}`,
      pullRequestNumber: FIRST.pullRequestNumber,
      sponsorPrincipalId: "prn_acme",
      queueDecisionDigest: D("a"),
    },
    policy: {
      version: 4,
      securityProfile: "fresh",
      runner: "command",
      requiredSuites,
      document: policyDocument,
    },
    workReceiptDigest: D("1"),
    previousTransitionDigest: null,
    issuedAt: "2026-08-11T23:26:49.720Z",
    executionSeconds: 1200,
    nonce: "nonce-local-run",
    runnerPrincipalId: "prn_acme",
    deviceKeyId,
    signer: { sign: async () => "jws-assignment" },
  });
  if ("error" in assignment) throw new Error(assignment.error);
  const parsedAssignment = parseIntegrationAssignment(assignment.record);
  if (!parsedAssignment.ok) throw new Error(parsedAssignment.detail);

  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, project_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, 'integration-assignment', ?, 'proj_acme', ?, NULL, ?, ?, ?)`,
    )
    .run(
      assignment.digest,
      REPO,
      REF,
      FIRST.attemptId,
      new TextDecoder().decode(assignment.bytes),
      assignment.jws,
    );
  const receipt = {
    assignmentId: rowAssignmentId,
    assignmentDigest: assignment.digest,
    candidateTreeOid: FIRST.treeOid,
    deviceKeyId,
    suites: requiredSuites.map((name) => ({ name, outcome: "passed" })),
  };
  const receiptDigest = await integrationReceiptDigest(receipt);
  raw
    .prepare(
      `INSERT INTO queue_assignments (
         assignment_id, github_repository_id, project_id, base_ref, attempt_id, assignment_digest,
         candidate_sha, candidate_tree_oid, principal_id, device_key_id, required_suites,
         execution_seconds, issued_at, receipt_digest, receipt_suites, receipt_accepted_at
       ) VALUES (?, ?, 'proj_acme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rowAssignmentId,
      REPO,
      REF,
      FIRST.attemptId,
      assignment.digest,
      candidateSha,
      FIRST.treeOid,
      "prn_acme",
      deviceKeyId,
      JSON.stringify(requiredSuites),
      1200,
      "2026-08-11T23:26:49.720Z",
      options.acceptReceipt === false ? null : receiptDigest,
      options.acceptReceipt === false
        ? null
        : JSON.stringify(receipt.suites),
      options.acceptReceipt === false ? null : "2026-08-11T23:26:52.907Z",
    );

  const signed = await signVerifiedIntent({
    operationId: `merge_${FIRST.attemptId}`,
    attemptId: FIRST.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: REPO,
      baseRef: REF,
      baseSha: FIRST.baseSha,
      headRepositoryId: REPO,
      headSha: FIRST.headSha,
      candidateSha: options.intentCandidateSha ?? candidateSha,
      candidateTreeOid: FIRST.treeOid,
      candidateParentOids: [FIRST.baseSha, FIRST.headSha],
    },
    position: { queueEpoch: 0, turnSequence: 13, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: FIRST.pullRequestNumber,
    evidence: {
      workReceiptDigest: D("1"),
      organizationId: "org_acme",
      policyDigest,
      pipelineDigest: D("3"),
      requiredSuitesDigest: await requiredSuitesDigest(requiredSuites),
      assignmentDigest: assignment.digest,
      integrationEvidenceDigest: receiptDigest,
      execution: { ranOn: "device", deviceKeyId },
    },
    mergeMethod: "merge",
    createdAt: "2026-08-11T23:26:58.086Z",
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, project_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, 'merge-intent', ?, 'proj_acme', ?, NULL, ?, ?, ?)`,
    )
    .run(signed.digest, REPO, REF, FIRST.attemptId, new TextDecoder().decode(signed.bytes), signed.jws);
  return signed.digest;
}

/** What GitHub says about every commit these tests name. */
const COMMITS: Record<string, { treeOid: string; parentShas: string[]; message: string }> = {
  [FIRST.baseSha]: { treeOid: FIRST.beforeTree, parentShas: ["5c".repeat(20)], message: "base" },
  [FIRST.mergeSha]: {
    treeOid: FIRST.treeOid,
    parentShas: [FIRST.baseSha, FIRST.headSha],
    // GitHub stores the message without the terminal line feed sent to its
    // commit-object API. This is the exact shape commitFacts reads in service.
    message: mergeCommitText(FIRST.pullRequestNumber, `merge_${FIRST.attemptId}`).replace(/\n$/, ""),
  },
};

const stubDeps: RecordFromIntentDeps<QueueRouteEnv> = {
  commitFacts: async (_env, _repositoryId, sha) => COMMITS[sha] ?? null,
  baseContainsSha: async () => true,
  pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: FIRST.mergeSha }),
  activePolicy: async () => ({
    projectId: "proj_acme",
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
  onQueue: (env, repositoryId, baseRef, decide) => runOnQueue(env, repositoryId, baseRef, decide),
};

async function appendFillerTransitions(e: QueueRouteEnv, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await runOnQueue(e, REPO, REF, ({ commands, store }) => {
      const tail = store.state().transitions.at(-1);
      return commands.recordTransition({
        idempotencyKey: `filler-transition-${index}`,
        kind: "reused",
        transitionSequence: (tail?.transitionSequence ?? 0) + 1,
        priorDigest: tail?.digest ?? null,
        digest: `sha256:${(index + 10).toString(16).padStart(64, "0")}`,
        baseSha: (index + 10).toString(16).padStart(40, "0"),
        attemptId: null,
        witnessPrincipalIds: [],
      });
    });
  }
}

describe("recordMergeFromIntent", () => {
  it("accepts the App-authored landed commit when the signed GitHub test-merge candidate has a different SHA", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent({ candidateSha: "2a".repeat(20) });

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test App commit after GitHub test merge",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({
      status: "recorded",
      attemptId: FIRST.attemptId,
      pullRequestNumber: FIRST.pullRequestNumber,
    });
  });

  it("repairs a verified local merge across an administrator-approved rebaseline gap exactly once", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const oldDigest = D("f");
    await runOnQueue(e, REPO, REF, ({ commands }) => {
      commands.recordTransition({
        idempotencyKey: "old-transition",
        kind: "verified",
        transitionSequence: 1,
        priorDigest: null,
        digest: oldDigest,
        baseSha: "0".repeat(40),
        attemptId: null,
        witnessPrincipalIds: [],
      });
      commands.observedExternalTransition({ idempotencyKey: "external", observedBaseSha: FIRST.baseSha });
      commands.rebaseline({
        idempotencyKey: "rebaseline",
        actorPrincipalId: "prn_acme",
        baseSha: FIRST.baseSha,
        reason: "approved setup cutover",
      });
    });

    const first = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "repair the missing test transition",
      attemptId: FIRST.attemptId,
    });
    const replay = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "replay the repaired test transition",
      attemptId: FIRST.attemptId,
    });

    expect(first).toMatchObject({ status: "recorded", sequence: 2, attemptId: FIRST.attemptId });
    expect(replay).toMatchObject({ status: "already", attemptId: FIRST.attemptId });
    if (first.status !== "recorded" || replay.status !== "already") throw new Error("repair did not finish");
    expect(first.repairAuditDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(replay.repairAuditDigest).toBe(first.repairAuditDigest);
    const rows = raw
      .prepare("SELECT kind, transition_sequence AS sequence, bytes FROM queue_attestations WHERE attempt_id = ? AND transition_sequence IS NOT NULL")
      .all(FIRST.attemptId) as Array<{ kind: string; sequence: number; bytes: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "verified-merge", sequence: 2 });
    expect(JSON.parse(rows[0]!.bytes)).toMatchObject({
      kind: "verified-merge",
      previousTransitionDigest: oldDigest,
      before: { baseSha: FIRST.baseSha },
      after: { baseSha: FIRST.mergeSha },
      verifiedMerge: { attemptId: FIRST.attemptId, pullRequestNumber: FIRST.pullRequestNumber },
    });
    const audit = raw
      .prepare(
        `SELECT kind, transition_sequence AS sequence, bytes, jws
           FROM queue_attestations WHERE digest = ?`,
      )
      .get(first.repairAuditDigest) as { kind: string; sequence: number | null; bytes: string; jws: string };
    expect(audit).toMatchObject({
      kind: "transition-repair-audit",
      sequence: null,
      jws: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
    });
    expect(JSON.parse(audit.bytes)).toMatchObject({
      schemaVersion: "1",
      kind: "transition-repair-audit",
      repositoryId: REPO,
      baseRef: REF,
      transitionDigest: first.transitionDigest,
      attemptId: FIRST.attemptId,
      actorPrincipalId: "prn_acme",
      reason: "repair the missing test transition",
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string,
    });
    expect(
      raw
        .prepare("SELECT digest FROM queue_attestations WHERE kind = 'transition-repair-audit'")
        .all(),
    ).toHaveLength(1);

    await runOnQueue(e, REPO, REF, ({ commands }) => {
      for (let index = 0; index < 105; index += 1) {
        commands.pause({
          idempotencyKey: `audit-pause-${index}`,
          actorPrincipalId: "prn_acme",
          reason: "force event compaction",
        });
        commands.resume({ idempotencyKey: `audit-resume-${index}`, actorPrincipalId: "prn_acme" });
      }
    });
    expect(raw.prepare("SELECT kind FROM queue_attestations WHERE digest = ?").get(first.repairAuditDigest)).toEqual({
      kind: "transition-repair-audit",
    });
    const queue = raw.prepare("SELECT document FROM queue_state WHERE github_repository_id = ?").get(REPO) as {
      document: string;
    };
    expect(queue.document).not.toContain('"reason":"repair the missing test transition"');
  });

  it("refuses a verified repair when the stored accepted receipt is missing", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent({ acceptReceipt: false });

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test missing accepted receipt",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/accepted receipt/i);
  });

  it("refuses a verified repair when the accepted receipt disagrees with the signed intent", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    raw.prepare("UPDATE queue_assignments SET receipt_digest = ? WHERE attempt_id = ?").run(D("7"), FIRST.attemptId);

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test mismatched accepted receipt",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/content digest/i);
  });

  it("refuses a merge intent stored under a digest its bytes do not match", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    raw.prepare("UPDATE queue_attestations SET bytes = bytes || ' ' WHERE kind = 'merge-intent'").run();

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test mis-keyed merge intent",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
  });

  it("refuses an assignment stored under a digest its bytes do not match", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    raw.prepare("UPDATE queue_attestations SET bytes = bytes || ' ' WHERE kind = 'integration-assignment'").run();

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test mis-keyed assignment",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/assignment bytes/i);
  });

  it("accepts a reused-proof App commit whose temporary test-merge candidate has a different SHA", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST, "f6".repeat(20));

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test reused-proof App commit after GitHub test merge",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "recorded", attemptId: FIRST.attemptId });
  });

  it("refuses when the stored assignment id differs from the signed assignment", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent({ rowAssignmentId: "asg_different" });

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test assignment id mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/assignment id/i);
  });

  it("refuses when the stored required suites differ from the signed assignment", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    raw.prepare("UPDATE queue_assignments SET required_suites = ? WHERE attempt_id = ?").run(
      JSON.stringify(["lint"]),
      FIRST.attemptId,
    );

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test required suites mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/required suites/i);
  });

  it.each([
    {
      name: "base commit",
      assignmentGit: { baseSha: "11".repeat(20) },
      detail: /base commit/i,
    },
    {
      name: "head commit",
      assignmentGit: { headSha: "22".repeat(20) },
      detail: /head commit/i,
    },
    {
      name: "head repository",
      assignmentGit: { headRepositoryId: "999999999" },
      detail: /head repository/i,
    },
    {
      name: "candidate parents",
      assignmentGit: { candidateParentOids: ["33".repeat(20), "44".repeat(20)] },
      detail: /candidate parents/i,
    },
  ])("refuses when the signed assignment $name differs from the intent", async ({ assignmentGit, detail }) => {
    const e = env();
    seed();
    await seedVerifiedIntent({ assignmentGit });

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test signed assignment git mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(detail);
  });

  it("refuses when the signed assignment and intent name different test-merge candidate commits", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent({ candidateSha: "2a".repeat(20), intentCandidateSha: "3b".repeat(20) });

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test test-merge candidate mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/signed assignment candidate commit/i);
  });

  it("refuses when the stored runner differs from the signed assignment", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    raw.prepare("UPDATE queue_assignments SET principal_id = ? WHERE attempt_id = ?").run(
      "prn_someone_else",
      FIRST.attemptId,
    );

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test runner mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/runner/i);
  });

  it("refuses the same tree and parents when the landed commit message differs", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const deps = {
      ...stubDeps,
      commitFacts: async (_env: QueueRouteEnv, _repositoryId: string, sha: string) => {
        const facts = COMMITS[sha];
        return facts === undefined ? null : { ...facts, message: sha === FIRST.mergeSha ? "different message" : facts.message };
      },
    };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test commit message mismatch",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/title, and message/i);
  });

  it("refuses any message difference beyond GitHub's one terminal line-feed normalization", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const deps = {
      ...stubDeps,
      commitFacts: async (_env: QueueRouteEnv, _repositoryId: string, sha: string) => {
        const facts = COMMITS[sha];
        return facts === undefined
          ? null
          : { ...facts, message: sha === FIRST.mergeSha ? `${facts.message}\n\n` : facts.message };
      },
    };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test exact terminal line-feed normalization",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/title, and message/i);
  });

  it("refuses an on-base intent-matching commit that GitHub does not name as the pull request merge", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const deps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: "aa".repeat(20) }),
    };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test exact pull request merge",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/pull request's merge commit/i);
  });

  it("replays safely after the signed row is stored but the queue link throws", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    let throwBeforeLink = true;
    const deps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      onQueue: async (...args) => {
        if (throwBeforeLink) {
          throwBeforeLink = false;
          throw new Error("injected stop before queue link");
        }
        return stubDeps.onQueue(...args);
      },
    };
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test store before link replay",
      attemptId: FIRST.attemptId,
    };

    await expect(recordMergeFromIntent(e, deps, input)).rejects.toThrow(/injected stop/i);
    expect(
      raw
        .prepare("SELECT transition_sequence FROM queue_attestations WHERE kind = 'verified-merge'")
        .all()
        .every((row) => (row as { transition_sequence: number | null }).transition_sequence === null),
    ).toBe(true);

    const replay = await recordMergeFromIntent(e, stubDeps, input);
    expect(replay).toMatchObject({ status: "recorded", sequence: 1 });
    expect(
      raw
        .prepare("SELECT digest FROM queue_attestations WHERE kind = 'verified-merge'")
        .all(),
    ).toHaveLength(1);
  });

  it("does not replace a valid staged row when service-key lookup fails", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    let throwBeforeLink = true;
    const interrupted: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      onQueue: async (...args) => {
        if (throwBeforeLink) {
          throwBeforeLink = false;
          throw new Error("injected stop before queue link");
        }
        return stubDeps.onQueue(...args);
      },
    };
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test service key outage",
      attemptId: FIRST.attemptId,
    };
    await expect(recordMergeFromIntent(e, interrupted, input)).rejects.toThrow(/injected stop/i);

    const underlying = e.DB as unknown as D1Like;
    const brokenKeys: D1Like = {
      prepare: (query) => {
        if (query.includes("SELECT public_jwk FROM service_keys")) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error("service key read failed");
              },
              first: async () => {
                throw new Error("service key read failed");
              },
              all: async () => {
                throw new Error("service key read failed");
              },
            }),
          };
        }
        return underlying.prepare(query);
      },
      batch: (statements) => underlying.batch(statements),
    };
    const brokenEnv = { ...e, DB: brokenKeys } as unknown as QueueRouteEnv;
    let replacementSigns = 0;
    const noReplacement: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      signRecordBytes: async (...args) => {
        replacementSigns += 1;
        return stubDeps.signRecordBytes(...args);
      },
    };

    await expect(recordMergeFromIntent(brokenEnv, noReplacement, input)).rejects.toThrow(/service key read failed/i);
    expect(replacementSigns).toBe(0);
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind = 'verified-merge'").all()).toHaveLength(1);

    expect(await recordMergeFromIntent(e, stubDeps, input)).toMatchObject({ status: "recorded", sequence: 1 });
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind = 'verified-merge'").all()).toHaveLength(1);
  });

  it("backfills the signed audit when audit signing fails after the durable link", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const deps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      signRecordBytes: async (...args) => {
        const typ = args[2];
        if (typ.includes("transition-repair-audit")) throw new Error("injected audit signer outage");
        return stubDeps.signRecordBytes(...args);
      },
    };
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "backfill audit after signer outage",
      attemptId: FIRST.attemptId,
    };

    await expect(recordMergeFromIntent(e, deps, input)).rejects.toThrow(/audit signer outage/i);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toHaveLength(1);
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind = 'transition-repair-audit'").all()).toHaveLength(0);

    const replay = await recordMergeFromIntent(e, stubDeps, input);
    expect(replay).toMatchObject({ status: "already", repairAuditDigest: expect.stringMatching(/^sha256:/) });
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind = 'transition-repair-audit'").all()).toHaveLength(1);
  });

  it("finds an already-positioned repair after its link is compacted out of the live tail", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test replay after chain compaction",
      attemptId: FIRST.attemptId,
    };
    const first = await recordMergeFromIntent(e, stubDeps, input);
    expect(first).toMatchObject({ status: "recorded", sequence: 1 });
    if (first.status !== "recorded") throw new Error("repair did not record");

    await appendFillerTransitions(e, 25);
    const { snapshot } = await readQueue(e, REPO, REF);
    expect(snapshot.transitions).toHaveLength(20);
    expect(snapshot.transitions.some((transition) => transition.digest === first.transitionDigest)).toBe(false);

    const replay = await recordMergeFromIntent(e, stubDeps, input);
    expect(replay).toMatchObject({ status: "already", transitionDigest: first.transitionDigest });
  });

  it("promotes a linked staged record after that link has left the live tail", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test promotion after chain compaction",
      attemptId: FIRST.attemptId,
    };
    const first = await recordMergeFromIntent(e, stubDeps, input);
    if (first.status !== "recorded") throw new Error("repair did not record");
    raw.prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?").run(first.transitionDigest);
    await appendFillerTransitions(e, 25);

    const replay = await recordMergeFromIntent(e, stubDeps, input);
    expect(replay).toMatchObject({ status: "already", transitionDigest: first.transitionDigest });
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE digest = ?").get(first.transitionDigest),
    ).toEqual({ sequence: 1 });
  });

  it("repairs a legacy positioned row that has no durable queue link", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const input = {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test legacy false position",
      attemptId: FIRST.attemptId,
    };
    const first = await recordMergeFromIntent(e, stubDeps, input);
    if (first.status !== "recorded") throw new Error("repair did not record");
    raw.prepare("DELETE FROM queue_transitions_index").run();
    raw.prepare("DELETE FROM queue_state").run();
    raw.prepare("DELETE FROM queue_projection_marks").run();

    const repaired = await recordMergeFromIntent(e, stubDeps, input);
    expect(repaired).toMatchObject({ status: "recorded", sequence: 1 });
    if (repaired.status !== "recorded") throw new Error("legacy repair did not record");
    expect(
      raw
        .prepare(
          "SELECT digest, transition_sequence AS sequence FROM queue_attestations WHERE kind = 'verified-merge' AND transition_sequence IS NOT NULL",
        )
        .all(),
    ).toEqual([{ digest: repaired.transitionDigest, sequence: 1 }]);
    expect(raw.prepare("SELECT digest FROM queue_transitions_index").all()).toEqual([
      { digest: repaired.transitionDigest },
    ]);
  });

  it("rejects a durable link whose signed record embeds another attempt", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const recorded = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "seed wrong embedded attempt test",
      attemptId: FIRST.attemptId,
    });
    if (recorded.status !== "recorded") throw new Error("repair did not record");
    const row = raw.prepare("SELECT bytes FROM queue_attestations WHERE digest = ?").get(recorded.transitionDigest) as {
      bytes: string;
    };
    const document = JSON.parse(row.bytes) as { verifiedMerge: { attemptId: string } };
    document.verifiedMerge.attemptId = "att_someone_else";
    const bytes = canonicalRecordBytes(document);
    const digest = await envelopeDigest(bytes);
    raw.prepare("UPDATE queue_transitions_index SET digest = ? WHERE digest = ?").run(digest, recorded.transitionDigest);
    raw
      .prepare("UPDATE queue_attestations SET digest = ?, bytes = ? WHERE digest = ?")
      .run(digest, new TextDecoder().decode(bytes), recorded.transitionDigest);

    expect(
      await durableTransitionForAttempt(e.DB as unknown as D1Like, {
        repositoryId: REPO,
        baseRef: REF,
        attemptId: FIRST.attemptId,
        mergeSha: FIRST.mergeSha,
      }),
    ).toBeNull();
  });

  it("rejects a durable link whose queue kind differs from its signed record kind", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const recorded = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "seed wrong durable kind test",
      attemptId: FIRST.attemptId,
    });
    if (recorded.status !== "recorded") throw new Error("repair did not record");
    raw.prepare("UPDATE queue_transitions_index SET kind = 'reused' WHERE digest = ?").run(recorded.transitionDigest);

    expect(
      await durableTransitionForAttempt(e.DB as unknown as D1Like, {
        repositoryId: REPO,
        baseRef: REF,
        attemptId: FIRST.attemptId,
        mergeSha: FIRST.mergeSha,
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "queue epoch",
      mutate: "UPDATE queue_transitions_index SET queue_epoch = queue_epoch + 1",
    },
    {
      name: "attestation row kind",
      mutate: "UPDATE queue_attestations SET kind = 'reused-proof-merge' WHERE kind = 'verified-merge'",
    },
    {
      name: "queue attempt",
      mutate: "UPDATE queue_transitions_index SET attempt_id = 'att_someone_else'",
    },
  ])("rejects a durable link with a mismatched $name", async ({ mutate }) => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const recorded = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "seed durable metadata mismatch test",
      attemptId: FIRST.attemptId,
    });
    if (recorded.status !== "recorded") throw new Error("repair did not record");
    raw.prepare(mutate).run();

    expect(
      await durableTransitionForAttempt(e.DB as unknown as D1Like, {
        repositoryId: REPO,
        baseRef: REF,
        attemptId: FIRST.attemptId,
        mergeSha: FIRST.mergeSha,
      }),
    ).toBeNull();
  });

  it("rejects a durable link whose stored bytes do not match its digest", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const recorded = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "seed mis-keyed transition bytes test",
      attemptId: FIRST.attemptId,
    });
    if (recorded.status !== "recorded") throw new Error("repair did not record");
    raw.prepare("UPDATE queue_attestations SET bytes = bytes || ' ' WHERE digest = ?").run(recorded.transitionDigest);

    expect(
      await durableTransitionForAttempt(e.DB as unknown as D1Like, {
        repositoryId: REPO,
        baseRef: REF,
        attemptId: FIRST.attemptId,
        mergeSha: FIRST.mergeSha,
      }),
    ).toBeNull();
  });

  it("does not report recorded when the queue rejects the transition link", async () => {
    const e = env();
    seed();
    await seedVerifiedIntent();
    const deps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...stubDeps,
      onQueue: (env, repositoryId, baseRef, decide) =>
        runOnQueue(env, repositoryId, baseRef, ({ store, commands }) => {
          Object.defineProperty(commands, "recordTransition", {
            value: () => ({ status: "rejected", detail: "injected link rejection" }),
          });
          return decide({ store, commands });
        }),
    };

    const outcome = await recordMergeFromIntent(e, deps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prn_acme",
      reason: "test rejected queue link",
      attemptId: FIRST.attemptId,
    });

    expect(outcome).toMatchObject({ status: "refused", code: "CHAIN_MOVED" });
    if (outcome.status === "refused") expect(outcome.detail).toMatch(/injected link rejection/i);
    expect(
      raw.prepare("SELECT digest FROM queue_attestations WHERE transition_sequence IS NOT NULL").all(),
    ).toHaveLength(0);
  });

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
      reason: "test commit not on base",
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
      reason: "test unreadable base ancestry",
    });

    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_ON_BASE" });
  });

  /** A range boundary must not make an already-recorded merge look absent. */
  it("does not record a second time for a merge the chain already holds behind the range", async () => {
    const e = env();
    seed();
    await seedIntent(FIRST);
    const recorded = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prin_test",
      reason: "seed valid historical transition",
    });
    expect(recorded).toMatchObject({ status: "recorded" });
    raw
      .prepare("UPDATE queue_projects SET attested_from_sequence = 5 WHERE github_repository_id = ?")
      .run(REPO);

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: FIRST.mergeSha,
      witnessPrincipalId: "prin_test",
      reason: "test old range replay",
    });

    expect(outcome).toMatchObject({ status: "already" });
  });

  it("refuses a commit the queue never authorized", async () => {
    const e = env();
    seed();
    const forged = "7f".repeat(20);
    COMMITS[forged] = {
      treeOid: "80".repeat(20),
      parentShas: [FIRST.baseSha, FIRST.headSha],
      message: "not written by the queue",
    };

    const outcome = await recordMergeFromIntent(e, stubDeps, {
      repositoryId: REPO,
      baseRef: REF,
      mergeSha: forged,
      witnessPrincipalId: "prin_test",
      reason: "test unauthorized commit",
    });

    delete COMMITS[forged];
    expect(outcome).toMatchObject({ status: "refused", code: "MERGE_NOT_AUTHORIZED" });
  });
});
