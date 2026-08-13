import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import {
  acceptedReceiptFor,
  issuedAssignment,
  issuedAssignmentForAttempt,
  recordAcceptedReceipt,
  recordIssuedAssignment,
} from "./assignment-store.js";
import type { D1Like } from "./projection.js";

/**
 * What the queue remembers about work it dispatched to a device.
 *
 * The merge gate reads these rows, and it reads them to decide whether a merge
 * may happen at all, so the storage has to make two things impossible rather
 * than unlikely: a second assignment for an attempt that already has one, and a
 * receipt replacing a receipt that was already accepted. Both are enforced by
 * the schema, not by the caller checking first.
 */

const open: Array<{ close(): void }> = [];
let db: D1Like;

function fresh(): D1Like {
  const t = testD1();
  seedActiveProject(t, { repositoryId: REPO });
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
const DEVICE = `SHA256:${"a".repeat(43)}`;

function assignment(overrides: Partial<Parameters<typeof recordIssuedAssignment>[1]> = {}) {
  return {
    assignmentId: "asg_1",
    repositoryId: REPO,
    baseRef: REF,
    attemptId: "att_1",
    assignmentDigest: `sha256:${"1".repeat(64)}`,
    candidateSha: "c".repeat(40),
    candidateTreeOid: TREE,
    principalId: "alice",
    deviceKeyId: DEVICE,
    requiredSuites: ["lint", "test"],
    executionSeconds: 1200,
    issuedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the assignments the queue has issued", () => {
  it("reads back everything the merge gate has to compare against", async () => {
    await recordIssuedAssignment(fresh(), assignment());

    const stored = await issuedAssignment(db, "asg_1");
    expect(stored).toMatchObject({
      assignmentId: "asg_1",
      attemptId: "att_1",
      candidateTreeOid: TREE,
      deviceKeyId: DEVICE,
      requiredSuites: ["lint", "test"],
      executionSeconds: 1200,
    });
    expect(stored?.receipt).toBeNull();
  });

  it("keeps the first assignment when a second is issued for the same attempt", async () => {
    await recordIssuedAssignment(fresh(), assignment());
    const second = await recordIssuedAssignment(
      db,
      assignment({ assignmentId: "asg_2", deviceKeyId: `SHA256:${"b".repeat(43)}` }),
    );

    expect(second.status).toBe("duplicate");
    const held = await issuedAssignmentForAttempt(db, "att_1");
    expect(held?.assignmentId).toBe("asg_1");
    expect(held?.deviceKeyId).toBe(DEVICE);
    expect(await issuedAssignment(db, "asg_2")).toBeNull();
  });

  it("has no assignment for an attempt nobody was dispatched for", async () => {
    expect(await issuedAssignmentForAttempt(fresh(), "att_nobody")).toBeNull();
  });

  it("rejects a delayed assignment from a released project incarnation", async () => {
    const store = fresh();
    await store.prepare(`DELETE FROM projects WHERE id = ?`).bind(`proj_${REPO}`).run();
    await store
      .prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name)
         VALUES ('project_new', ?, ?, 'owner/repo')`,
      )
      .bind(`org_${REPO}`, REPO)
      .run();

    await expect(
      recordIssuedAssignment(store, assignment({ projectId: `proj_${REPO}` })),
    ).rejects.toThrow(/unavailable/);
    expect(await issuedAssignment(store, "asg_1")).toBeNull();
  });
});

describe("the receipt the queue accepted", () => {
  it("is readable by the attempt it belongs to once it is accepted", async () => {
    await recordIssuedAssignment(fresh(), assignment());
    const accepted = await recordAcceptedReceipt(db, {
      assignmentId: "asg_1",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      suites: [{ name: "lint", outcome: "passed" }],
      acceptedAt: "2026-08-01T00:10:00.000Z",
    });

    expect(accepted.status).toBe("applied");
    expect(await acceptedReceiptFor(db, "att_1")).toMatchObject({
      assignmentId: "asg_1",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      candidateTreeOid: TREE,
      deviceKeyId: DEVICE,
    });
  });

  it("refuses to replace a receipt that was already accepted", async () => {
    await recordIssuedAssignment(fresh(), assignment());
    await recordAcceptedReceipt(db, {
      assignmentId: "asg_1",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      suites: [{ name: "lint", outcome: "passed" }],
      acceptedAt: "2026-08-01T00:10:00.000Z",
    });

    const again = await recordAcceptedReceipt(db, {
      assignmentId: "asg_1",
      receiptDigest: `sha256:${"3".repeat(64)}`,
      suites: [{ name: "lint", outcome: "passed" }],
      acceptedAt: "2026-08-01T00:20:00.000Z",
    });

    expect(again.status).toBe("duplicate");
    const receipt = await acceptedReceiptFor(db, "att_1");
    expect(receipt?.receiptDigest).toBe(`sha256:${"2".repeat(64)}`);
  });

  it("accepts no receipt for an assignment nobody issued", async () => {
    const result = await recordAcceptedReceipt(fresh(), {
      assignmentId: "asg_missing",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      suites: [],
      acceptedAt: "2026-08-01T00:10:00.000Z",
    });
    expect(result.status).toBe("unknown-assignment");
  });

  it("has no accepted receipt while the assignment is still out", async () => {
    await recordIssuedAssignment(fresh(), assignment());
    expect(await acceptedReceiptFor(db, "att_1")).toBeNull();
  });
});
