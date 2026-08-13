import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, testD1, type TestD1 } from "../test/d1.js";

const MIGRATION = "0033_verifier_protocol_v3.sql";
const open: TestD1[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("migration 0033: post-schema deployment barrier", () => {
  it("rolls back an unstamped generation and can retry after a valid deploy", () => {
    const test = testD1({ upTo: MIGRATION, rollout: "as-migrated" });
    open.push(test);
    test.raw.prepare("UPDATE project_lifecycle_rollout SET worker_deployment_id = 'unstamped'").run();

    expect(() => test.raw.transaction(() => applyMigration(test.raw, MIGRATION))())
      .toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(MIGRATION)).toBeUndefined();
    expect(test.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verifier_v3_deploy_guard'",
    ).get()).toBeUndefined();
    expect(test.raw.prepare("SELECT name FROM pragma_table_info('queue_projects') WHERE name = 'verifier_protocol'").get())
      .toBeUndefined();

    const generation = "00000000-0000-4000-8000-000000000077";
    test.raw.prepare("UPDATE project_lifecycle_rollout SET worker_deployment_id = ?").run(generation);
    test.raw.transaction(() => applyMigration(test.raw, MIGRATION))();
    expect(test.raw.prepare(
      "SELECT worker_deployment_id AS currentId, verifier_v3_predeploy_id AS barrierId FROM project_lifecycle_rollout",
    ).get()).toEqual({ currentId: generation, barrierId: generation });
    expect(test.raw.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(MIGRATION)).toEqual({ name: MIGRATION });
  });

  it.each([
    "00000000-0000-0000-8000-000000000001",
    "00000000-0000-4000-0000-000000000001",
  ])("rolls back a malformed UUID generation %s", (generation) => {
    const test = testD1({ upTo: MIGRATION, rollout: "as-migrated" });
    open.push(test);
    test.raw.prepare("UPDATE project_lifecycle_rollout SET worker_deployment_id = ?").run(generation);
    expect(() => test.raw.transaction(() => applyMigration(test.raw, MIGRATION))())
      .toThrow(/CHECK constraint failed/);
    expect(test.raw.prepare("SELECT name FROM d1_migrations WHERE name = ?").get(MIGRATION)).toBeUndefined();
    expect(test.raw.prepare("SELECT name FROM pragma_table_info('queue_projects') WHERE name = 'verifier_protocol'").get())
      .toBeUndefined();
  });
});
