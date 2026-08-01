import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { latestVerification } from "./latest-verification.js";

/**
 * The dashboard showed "—" for a project's last verification while the
 * operations view on the same screen showed a real result for it. Two queries,
 * two rules, one question.
 */

const open: Array<{ close(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

async function seeded(): Promise<{ db: D1Database }> {
  const t = testD1();
  open.push(t);
  await t.db
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'acme')")
    .bind()
    .run();
  await t.db
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('proj_1', 'org_1', '1', 'acme/repo', 1)",
    )
    .bind()
    .run();
  return { db: t.db };
}

/** Ask the question the dashboard asks. */
async function ask(db: D1Database): Promise<{ outcome: string | null; at: string | null }> {
  const row = await db
    .prepare(
      `SELECT ${latestVerification("outcome")} AS outcome, ${latestVerification("at")} AS at FROM projects p WHERE p.id = 'proj_1'`,
    )
    .bind()
    .first<{ outcome: string | null; at: string | null }>();
  return row ?? { outcome: null, at: null };
}

async function verification(db: D1Database, outcome: string | null, completedAt: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json, check_name, status, outcome, completed_at)
       VALUES (?, 'proj_1', 'check_suite', 'abc', 'refs/heads/main', 'test', 'app', '{}', 'thwip', 'completed', ?, ?)`,
    )
    .bind(`pv_${completedAt ?? "none"}_${outcome ?? "none"}`, outcome, completedAt)
    .run();
}

async function observation(db: D1Database, outcome: string, observedAt: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO verification_observations (project_id, head_sha, outcome, observed_at) VALUES ('proj_1', 'abc', ?, ?)",
    )
    .bind(outcome, observedAt)
    .run();
}

describe("the last verification a project had", () => {
  it("says nothing when nothing has been verified", async () => {
    const { db } = await seeded();
    expect(await ask(db)).toEqual({ outcome: null, at: null });
  });

  it("takes a verification the App made itself", async () => {
    const { db } = await seeded();
    await verification(db, "pass", "2026-08-01T10:00:00Z");
    expect(await ask(db)).toEqual({ outcome: "pass", at: "2026-08-01T10:00:00Z" });
  });

  /**
   * The bug. Preferring proof_verifications hid this observation behind an
   * older verification, so the project list said "pass" from yesterday while
   * the operations view said "fail" from an hour ago.
   */
  it("prefers a newer observation over an older verification", async () => {
    const { db } = await seeded();
    await verification(db, "pass", "2026-07-31T10:00:00Z");
    await observation(db, "fail", "2026-08-01T09:00:00Z");
    expect(await ask(db)).toEqual({ outcome: "fail", at: "2026-08-01T09:00:00Z" });
  });

  it("prefers a newer verification over an older observation", async () => {
    const { db } = await seeded();
    await observation(db, "fail", "2026-07-31T09:00:00Z");
    await verification(db, "pass", "2026-08-01T10:00:00Z");
    expect(await ask(db)).toEqual({ outcome: "pass", at: "2026-08-01T10:00:00Z" });
  });

  /**
   * Both columns must describe the same event. Two independent COALESCE
   * expressions could take the outcome from one row and the time from another,
   * reporting something that never happened.
   */
  it("never reports one row's outcome with another row's time", async () => {
    const { db } = await seeded();
    await verification(db, null, "2026-08-01T10:00:00Z");
    await observation(db, "fail", "2026-07-31T09:00:00Z");

    const answer = await ask(db);
    expect(answer.at).toBe("2026-08-01T10:00:00Z");
    expect(answer.outcome).toBeNull();
  });

  /** A row with no timestamp cannot be the latest anything. */
  it("ignores a verification that never recorded when it finished", async () => {
    const { db } = await seeded();
    await verification(db, "pass", null);
    await observation(db, "fail", "2026-07-31T09:00:00Z");
    expect(await ask(db)).toEqual({ outcome: "fail", at: "2026-07-31T09:00:00Z" });
  });
});
