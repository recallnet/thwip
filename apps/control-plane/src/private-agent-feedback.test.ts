import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1, type TestD1 } from "../test/d1.js";
import { runPrivateFeedbackRetention } from "./private-agent-feedback.js";
import { acquireProjectWriteLease } from "./project-lifecycle.js";

const REPOSITORY_ID = "1319756073";
const PROJECT_ID = "project_feedback";
const ORGANIZATION_ID = "organization_feedback";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const open: TestD1[] = [];
let sequence = 0;

function fixture(): TestD1 {
  const test = testD1();
  open.push(test);
  seedActiveProject(test, {
    repositoryId: REPOSITORY_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    githubName: "example/private-repository",
  });
  test.raw.prepare("UPDATE organizations SET installation_id = '44001' WHERE id = ?").run(ORGANIZATION_ID);
  test.raw.pragma("foreign_keys = ON");
  return test;
}

async function seedPrivateReport(test: TestD1, submittedAt = NOW) {
  sequence += 1;
  const suffix = String(sequence).padStart(8, "0");
  const receiptId = `afr_${suffix}`;
  const rootId = `afp_${suffix}`;
  const eventId = `afe_${suffix}`;
  const deleteAt = new Date(submittedAt.getTime() + 90 * 24 * 60 * 60_000).toISOString();
  const expiresAt = new Date(submittedAt.getTime() + 365 * 24 * 60 * 60_000).toISOString();
  const lease = await acquireProjectWriteLease(test.db, REPOSITORY_ID, PROJECT_ID);
  if (lease === null) throw new Error("test project lease unavailable");
  try {
    test.raw.prepare(
      `INSERT INTO agent_report_receipts
         (id, status, created_at, updated_at, expires_at)
       VALUES (?, 'submitted', ?, ?, ?)`,
    ).run(receiptId, submittedAt.toISOString(), submittedAt.toISOString(), expiresAt);
    test.raw.prepare(
      `INSERT INTO agent_report_private_roots
         (id, receipt_id, project_id, payload_binding, submitted_at, delete_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      rootId,
      receiptId,
      PROJECT_ID,
      `hmac-sha256:v1:${suffix.padEnd(64, "a")}`,
      submittedAt.toISOString(),
      deleteAt,
    );
    test.raw.prepare(
      `INSERT INTO agent_report_content (private_root_id, kind, title, description)
       VALUES (?, 'feature', 'Explain blocked queue status',
               'Show one short next step when a pull request cannot enter the queue.')`,
    ).run(rootId);
    test.raw.prepare(
      `INSERT INTO agent_report_provenance
         (private_root_id, better_auth_user_id, github_user_id, github_installation_id,
          github_repository_id, cli_version, accepted_at)
       VALUES (?, 'better-auth-user', '99101', '44001', ?, '0.1.0', ?)`,
    ).run(rootId, REPOSITORY_ID, submittedAt.toISOString());
    test.raw.prepare(
      `INSERT INTO agent_report_events (id, private_root_id, action, actor_role, occurred_at)
       VALUES (?, ?, 'submitted', 'submitter', ?)`,
    ).run(eventId, rootId, submittedAt.toISOString());
  } finally {
    await lease.release();
  }
  return { receiptId, rootId, deleteAt, expiresAt };
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  sequence = 0;
});

describe("private agent feedback foundation", () => {
  it("separates project-scoped private data from the anonymous receipt", async () => {
    const test = fixture();
    const report = await seedPrivateReport(test);
    expect(test.raw.prepare(
      "SELECT project_id AS projectId, payload_binding AS binding FROM agent_report_private_roots",
    ).get()).toEqual({ projectId: PROJECT_ID, binding: `hmac-sha256:v1:${"00000001".padEnd(64, "a")}` });
    expect(test.raw.prepare("SELECT * FROM agent_report_provenance").get()).toMatchObject({
      better_auth_user_id: "better-auth-user",
      github_user_id: "99101",
      github_installation_id: "44001",
      github_repository_id: REPOSITORY_ID,
    });
    const receipt = test.raw.prepare("SELECT * FROM agent_report_receipts WHERE id = ?").get(report.receiptId);
    expect(Object.keys(receipt as object)).toEqual([
      "id", "status", "created_at", "updated_at", "final_at", "content_deleted_at", "expires_at",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(/project_feedback|1319756073|better-auth-user|99101|44001/);
  });

  it("refuses roots without an exact live project lease", () => {
    const test = fixture();
    test.raw.prepare(
      `INSERT INTO agent_report_receipts
         (id, status, created_at, updated_at, expires_at)
       VALUES ('receipt_direct', 'submitted', ?, ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString(), "2027-08-13T12:00:00.000Z");
    expect(() => test.raw.prepare(
      `INSERT INTO agent_report_private_roots
         (id, receipt_id, project_id, payload_binding, submitted_at, delete_at)
       VALUES ('root_direct', 'receipt_direct', ?, ?, ?, ?)`,
    ).run(PROJECT_ID, `hmac-sha256:v1:${"a".repeat(64)}`, NOW.toISOString(), "2026-11-11T12:00:00.000Z"))
      .toThrow("private feedback project unavailable");
  });

  it("hard-stops private reads at 90 days before physical deletion", async () => {
    const test = fixture();
    const report = await seedPrivateReport(test);
    const read = (at: string) => test.raw.prepare(
      `SELECT content.kind, content.title, content.description
         FROM agent_report_private_roots root
         JOIN agent_report_content content ON content.private_root_id = root.id
        WHERE root.id = ? AND root.project_id = ? AND root.delete_at > ?`,
    ).get(report.rootId, PROJECT_ID, at);
    expect(read("2026-11-11T11:59:59.999Z")).toMatchObject({
      kind: "feature",
      title: "Explain blocked queue status",
    });
    expect(read(report.deleteAt)).toBeUndefined();
  });

  it("purges private content before its deadline and keeps only the anonymous receipt", async () => {
    const test = fixture();
    const report = await seedPrivateReport(test, new Date("2026-05-15T12:04:00.000Z"));
    await expect(runPrivateFeedbackRetention(test.db, NOW)).resolves.toEqual({
      skipped: false, privateRootsDeleted: 1, receiptsDeleted: 0,
    });
    for (const table of [
      "agent_report_private_roots", "agent_report_content", "agent_report_provenance", "agent_report_events",
    ]) expect(test.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    const retained = test.raw.prepare(
      `SELECT id, status, content_deleted_at AS contentDeletedAt
         FROM agent_report_receipts WHERE id = ?`,
    ).get(report.receiptId);
    expect(retained).toEqual({ id: report.receiptId, status: "closed", contentDeletedAt: NOW.toISOString() });
    expect(JSON.stringify(retained)).not.toMatch(/project_feedback|1319756073|better-auth-user/);
  });

  it("does not shorten the anonymous receipt's one-year lifetime", async () => {
    const test = fixture();
    const report = await seedPrivateReport(test);
    test.raw.prepare("UPDATE agent_report_receipts SET expires_at = ? WHERE id = ?")
      .run("2026-08-13T12:04:00.000Z", report.receiptId);
    await expect(runPrivateFeedbackRetention(test.db, NOW)).resolves.toMatchObject({ receiptsDeleted: 0 });
    test.raw.prepare(
      "UPDATE agent_report_retention_clock SET claim_token = NULL, claim_expires_at = NULL, last_started_at = NULL",
    ).run();
    await expect(runPrivateFeedbackRetention(test.db, new Date("2026-08-13T12:04:00.000Z")))
      .resolves.toMatchObject({ receiptsDeleted: 1 });
  });

  it("records retention failures without storing private error text and retries safely", async () => {
    const test = fixture();
    const report = await seedPrivateReport(test, new Date("2026-05-15T11:59:00.000Z"));
    const failingDb = { ...test.db, batch: async () => { throw new Error("private injected database details"); } };
    await expect(runPrivateFeedbackRetention(failingDb as never, NOW)).rejects.toThrow("private injected");
    expect(test.raw.prepare(
      "SELECT claim_token AS claimToken, last_error AS lastError FROM agent_report_retention_clock WHERE id = 1",
    ).get()).toEqual({ claimToken: null, lastError: "private feedback retention failed" });
    expect(JSON.stringify(test.raw.prepare("SELECT * FROM agent_report_retention_clock").get()))
      .not.toContain("private injected database details");
    const retryAt = new Date("2026-08-13T12:04:31.000Z");
    await expect(runPrivateFeedbackRetention(test.db, retryAt)).resolves.toMatchObject({ privateRootsDeleted: 1 });
    expect(test.raw.prepare("SELECT status FROM agent_report_receipts WHERE id = ?").get(report.receiptId))
      .toEqual({ status: "closed" });
  });

  it("recovers an expired claim and excludes a second owner", async () => {
    const test = fixture();
    test.raw.prepare(
      `UPDATE agent_report_retention_clock
          SET claim_token = 'crashed', claim_expires_at = '2026-08-13T11:59:00.000Z',
              last_started_at = '2026-08-13T11:50:00.000Z'`,
    ).run();
    expect((await runPrivateFeedbackRetention(test.db, NOW)).skipped).toBe(false);
    expect((await runPrivateFeedbackRetention(test.db, NOW)).skipped).toBe(true);
  });

  it("fails visibly when a bounded page cannot clear an overdue backlog", async () => {
    const test = fixture();
    for (let index = 0; index < 3; index += 1) {
      await seedPrivateReport(test, new Date(`2026-05-15T11:5${index}:00.000Z`));
    }
    await expect(runPrivateFeedbackRetention(test.db, NOW, 2)).rejects.toThrow("retention is overdue");
    expect(test.raw.prepare("SELECT count(*) AS count FROM agent_report_private_roots").get()).toEqual({ count: 1 });
    expect(test.raw.prepare("SELECT last_error FROM agent_report_retention_clock").get()).toEqual({
      last_error: "private feedback retention failed",
    });
  });
});
