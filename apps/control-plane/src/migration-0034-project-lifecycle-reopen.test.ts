import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, testD1, type TestD1 } from "../test/d1.js";

const MIGRATION = "0034_reopen_after_project_lifecycle.sql";
const open: TestD1[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fenced(): TestD1 {
  const test = testD1({ upTo: MIGRATION, rollout: "as-migrated" });
  open.push(test);
  expect(test.raw.prepare(
    "SELECT maintenance_mode AS maintenance, destructive_schema_ready_at AS ready FROM project_lifecycle_rollout",
  ).get()).toEqual({ maintenance: 1, ready: expect.any(String) });
  return test;
}

function applyAtomically(test: TestD1): void {
  test.raw.transaction(() => applyMigration(test.raw, MIGRATION))();
}

function markPostV3Deploy(test: TestD1): void {
  test.raw.prepare(
    `UPDATE project_lifecycle_rollout
        SET worker_deployment_id = '00000000-0000-4000-8000-000000000099'
      WHERE id = 1`,
  ).run();
}

describe("migration 0034: guarded project lifecycle reopen", () => {
  it("is the only phase that clears maintenance after 0031, 0032, and 0033", () => {
    const test = fenced();
    markPostV3Deploy(test);
    applyAtomically(test);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 0 });
    expect(test.raw.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(MIGRATION))
      .toEqual({ name: MIGRATION });
  });

  it("rolls back and keeps traffic fenced when a prerequisite migration record is missing", () => {
    const test = fenced();
    markPostV3Deploy(test);
    test.raw.prepare("DELETE FROM d1_migrations WHERE name = '0033_verifier_protocol_v3.sql'").run();
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
    expect(test.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'project_lifecycle_reopen_guard'").get())
      .toBeUndefined();
    expect(test.raw.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(MIGRATION)).toBeUndefined();
  });

  it("rolls back when the exact serving Worker has not recorded its build", () => {
    const test = fenced();
    markPostV3Deploy(test);
    test.raw.prepare("UPDATE project_lifecycle_rollout SET worker_build_sha = NULL").run();
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });

  it("rolls back when the reviewed capability evidence is incomplete", () => {
    const test = fenced();
    markPostV3Deploy(test);
    const evidence = JSON.parse(String(test.raw.prepare(
      "SELECT remote_capability_evidence AS evidence FROM project_lifecycle_rollout",
    ).get().evidence)) as Record<string, unknown>;
    evidence["approvedBy"] = "   ";
    test.raw.prepare("UPDATE project_lifecycle_rollout SET remote_capability_evidence = ?")
      .run(JSON.stringify(evidence));
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });

  it.each([
    ["a non-text timestamp", (evidence: Record<string, unknown>) => {
      (evidence["d1"] as Record<string, unknown>)["exportCompletedAt"] = 2451544.5;
    }],
    ["a boolean foreign-key count", (evidence: Record<string, unknown>) => {
      (evidence["d1"] as Record<string, unknown>)["foreignKeyViolations"] = false;
    }],
  ])("rolls back for %s even when SQLite could coerce it", (_reason, mutate) => {
    const test = fenced();
    markPostV3Deploy(test);
    const evidence = JSON.parse(String(test.raw.prepare(
      "SELECT remote_capability_evidence AS evidence FROM project_lifecycle_rollout",
    ).get().evidence)) as Record<string, unknown>;
    mutate(evidence);
    test.raw.prepare("UPDATE project_lifecycle_rollout SET remote_capability_evidence = ?")
      .run(JSON.stringify(evidence));
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });

  it("cannot skip the 0033 schema even if somebody invokes its SQL directly", () => {
    const test = testD1({ upTo: "0033_verifier_protocol_v3.sql", rollout: "as-migrated" });
    open.push(test);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });

  it("rolls back when no Worker generation deployed after migration 0033", () => {
    const test = fenced();
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });

  it("rolls back a malformed post-0033 deployment UUID", () => {
    const test = fenced();
    test.raw.prepare(
      "UPDATE project_lifecycle_rollout SET worker_deployment_id = '00000000-0000-0000-8000-000000000099'",
    ).run();
    expect(() => applyAtomically(test)).toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT maintenance_mode AS maintenance FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance: 1 });
  });
});
