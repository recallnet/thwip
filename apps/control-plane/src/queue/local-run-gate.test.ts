import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { recordAcceptedReceipt, recordIssuedAssignment } from "./assignment-store.js";
import { localRunEvidenceFor } from "./local-run-gate.js";
import { commandsFor, walkToMergeReady } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";

/**
 * The refusal that makes `fresh` a profile.
 *
 * Issuing an assignment and accepting a receipt are worth nothing on their own.
 * What `fresh` claims is that the required suites ran for this turn, against the
 * integrated candidate, on the machine the queue dispatched to, and the only way
 * to claim that is to refuse the merge when any part of it is missing.
 *
 * Every refusal below is reached through the same two functions the merge gate
 * calls, with the evidence read from storage rather than handed in: a caller
 * cannot construct a `MergeEvidence`, so there is no version of this path that
 * runs on a value somebody made up.
 */

const open: Array<{ close(): void }> = [];
let db: D1Like;

function fresh(): D1Like {
  const t = testD1();
  open.push(t);
  db = t.db;
  return t.db;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "a".repeat(40);
const OTHER_TREE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const BASE = "d".repeat(40);
const HEAD = "e".repeat(40);
const DEVICE = `SHA256:${"a".repeat(43)}`;
const OTHER_DEVICE = `SHA256:${"z".repeat(43)}`;
const ASSIGNMENT_DIGEST = `sha256:${"1".repeat(64)}`;
const RECEIPT_DIGEST = `sha256:${"2".repeat(64)}`;

async function issue(overrides: { deviceKeyId?: string; candidateTreeOid?: string } = {}): Promise<void> {
  await recordIssuedAssignment(db, {
    assignmentId: "asg_1",
    repositoryId: REPO,
    baseRef: REF,
    attemptId: "att_1",
    assignmentDigest: ASSIGNMENT_DIGEST,
    candidateSha: CANDIDATE,
    candidateTreeOid: overrides.candidateTreeOid ?? TREE,
    principalId: "alice",
    deviceKeyId: overrides.deviceKeyId ?? DEVICE,
    requiredSuites: ["lint"],
    executionSeconds: 1200,
    issuedAt: "2026-08-01T00:00:00.000Z",
  });
}

async function accept(): Promise<void> {
  await recordAcceptedReceipt(db, {
    assignmentId: "asg_1",
    receiptDigest: RECEIPT_DIGEST,
    suites: [{ name: "lint", outcome: "passed" }],
    acceptedAt: "2026-08-01T00:05:00.000Z",
  });
}

describe("what a merge under fresh is allowed to rest on", () => {
  it("refuses when no device was ever assigned this attempt", async () => {
    const result = await localRunEvidenceFor(fresh(), {
      securityProfile: "fresh",
      attemptId: "att_1",
      candidateTreeOid: TREE,
    });
    expect(result).toMatchObject({ ok: false, code: "INTEGRATION_ASSIGNMENT_MISSING" });
  });

  it("refuses while the assigned device has returned nothing", async () => {
    fresh();
    await issue();
    const result = await localRunEvidenceFor(db, {
      securityProfile: "fresh",
      attemptId: "att_1",
      candidateTreeOid: TREE,
    });
    expect(result).toMatchObject({ ok: false, code: "INTEGRATION_RECEIPT_MISSING" });
  });

  it("refuses a receipt about a tree other than the one being merged", async () => {
    fresh();
    await issue();
    await accept();
    const result = await localRunEvidenceFor(db, {
      securityProfile: "fresh",
      attemptId: "att_1",
      candidateTreeOid: OTHER_TREE,
    });
    expect(result).toMatchObject({ ok: false, code: "INTEGRATION_RECEIPT_TREE_MISMATCH" });
  });

  it("refuses under audited on the same terms as under fresh", async () => {
    const result = await localRunEvidenceFor(fresh(), {
      securityProfile: "audited",
      attemptId: "att_1",
      candidateTreeOid: TREE,
    });
    expect(result).toMatchObject({ ok: false, code: "INTEGRATION_ASSIGNMENT_MISSING" });
  });

  it("carries the accepted receipt once there is one", async () => {
    fresh();
    await issue();
    await accept();
    const result = await localRunEvidenceFor(db, {
      securityProfile: "fresh",
      attemptId: "att_1",
      candidateTreeOid: TREE,
    });
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    expect(result.evidence.localRun).toEqual({
      assignmentDigest: ASSIGNMENT_DIGEST,
      receiptDigest: RECEIPT_DIGEST,
      candidateTreeOid: TREE,
      deviceKeyId: DEVICE,
    });
  });

  it("asks nothing of a profile that dispatches no work to a device", async () => {
    for (const securityProfile of ["fast", "remote", null]) {
      const result = await localRunEvidenceFor(fresh(), {
        securityProfile,
        attemptId: "att_1",
        candidateTreeOid: TREE,
      });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.evidence.localRun).toBeNull();
    }
  });
});

/**
 * The same evidence, checked a second time against the queue document.
 *
 * Storage says a receipt was accepted; the document says who was given the turn
 * and what tree they were given. Both have to agree, because a merge is written
 * on the strength of the two together.
 */

interface Held {
  attemptId: string;
}

/** A turn claimed by a device, run, and answered, as the routes leave it. */
async function deviceHoldsTurn(
  input: { deviceKeyId?: string; receiptDigest?: string; assignmentDigest?: string; candidateTree?: string } = {},
): Promise<Held> {
  return withQueueState(db, REPO, REF, async (store) => {
    const commands = commandsFor(store);
    commands.requestQueue({
      idempotencyKey: "req",
      entryId: "entry_1",
      pullRequestNumber: 82,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha: HEAD,
    });
    commands.evaluateReadiness({
      idempotencyKey: "ready",
      entryId: "entry_1",
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
    });
    await commands.tick({ idempotencyKey: "tick"});
    const attemptId = store.state().activeAttemptId;
    if (attemptId === null) throw new Error("no offer was made");
    commands.claim({
      idempotencyKey: "claim",
      attemptId,
      executionMode: "device",
      deviceId: input.deviceKeyId ?? DEVICE,
    });
    commands.candidatePrepared({
      idempotencyKey: "candidate",
      attemptId,
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTree: input.candidateTree ?? TREE,
      policyDigest: `sha256:${"9".repeat(64)}`,
      runner: "local-run",
    });
    commands.assign({
      idempotencyKey: "assign",
      attemptId,
      assignmentDigest: input.assignmentDigest ?? ASSIGNMENT_DIGEST,
    });
    commands.submitReceipt({
      idempotencyKey: "receipt",
      attemptId,
      receiptDigest: input.receiptDigest ?? RECEIPT_DIGEST,
    });
    return { attemptId };
  });
}

describe("the walk to a merge write, under fresh", () => {
  /**
   * The attempt the routes create is named by the queue, and the stored
   * assignment names it too. These tests seed the assignment against whatever
   * attempt the offer produced, so the row and the document are about one turn.
   */
  async function issueFor(held: Held, overrides: { deviceKeyId?: string } = {}): Promise<void> {
    await recordIssuedAssignment(db, {
      assignmentId: "asg_1",
      repositoryId: REPO,
      baseRef: REF,
      attemptId: held.attemptId,
      assignmentDigest: ASSIGNMENT_DIGEST,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
      principalId: "alice",
      deviceKeyId: overrides.deviceKeyId ?? DEVICE,
      requiredSuites: ["lint"],
      executionSeconds: 1200,
      issuedAt: "2026-08-01T00:00:00.000Z",
    });
    await accept();
  }

  async function walkFor(held: Held): Promise<{ operationId: string | null; refusal?: string }> {
    const evidence = await localRunEvidenceFor(db, {
      securityProfile: "fresh",
      attemptId: held.attemptId,
      candidateTreeOid: TREE,
    });
    if (!evidence.ok) throw new Error(`the gate refused before the walk: ${evidence.code}`);
    return withQueueState(db, REPO, REF, (store) => {
      const commands = commandsFor(store);
      const result = walkToMergeReady(commands, store, {
        attemptId: held.attemptId,
        baseSha: BASE,
        headSha: HEAD,
        candidateSha: CANDIDATE,
        candidateTree: TREE,
        policyDigest: `sha256:${"9".repeat(64)}`,
        runner: "local-run",
        evidence: evidence.evidence,
        receiptDigest: `sha256:${"7".repeat(64)}`,
        verifierResultDigest: RECEIPT_DIGEST,
        intentDigest: `sha256:${"8".repeat(64)}`,
        operationId: "op_1",
      });
      return { operationId: result.operationId, refusal: result.refusal };
    });
  }

  it("writes the merge when the document and the receipt agree", async () => {
    fresh();
    const held = await deviceHoldsTurn();
    await issueFor(held);
    expect(await walkFor(held)).toMatchObject({ operationId: "op_1" });
  });

  it("refuses when the receipt came from a device other than the one that claimed the turn", async () => {
    fresh();
    const held = await deviceHoldsTurn({ deviceKeyId: OTHER_DEVICE });
    await issueFor(held);
    expect(await walkFor(held)).toMatchObject({
      operationId: null,
      refusal: "INTEGRATION_RECEIPT_DEVICE_MISMATCH",
    });
  });

  it("refuses when the queue recorded a different receipt than the one that was accepted", async () => {
    fresh();
    const held = await deviceHoldsTurn({ receiptDigest: `sha256:${"5".repeat(64)}` });
    await issueFor(held);
    expect(await walkFor(held)).toMatchObject({ operationId: null, refusal: "INTEGRATION_RECEIPT_MISMATCH" });
  });

  it("refuses when the queue recorded a different assignment than the one the receipt answers", async () => {
    fresh();
    const held = await deviceHoldsTurn({ assignmentDigest: `sha256:${"6".repeat(64)}` });
    await issueFor(held);
    expect(await walkFor(held)).toMatchObject({ operationId: null, refusal: "INTEGRATION_ASSIGNMENT_MISMATCH" });
  });

  it("refuses when the attempt was pinned to a tree the receipt is not about", async () => {
    fresh();
    const held = await deviceHoldsTurn({ candidateTree: OTHER_TREE });
    await issueFor(held);
    expect(await walkFor(held)).toMatchObject({ operationId: null, refusal: "INTEGRATION_RECEIPT_TREE_MISMATCH" });
  });
});
