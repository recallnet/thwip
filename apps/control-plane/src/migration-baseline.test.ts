import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_MIGRATION_RELEASE,
  BASELINE_MIGRATION_RELEASES,
  MIGRATION_RELEASES,
  evaluateMigrationReleases,
  migrationReleaseState,
  migrationTrack,
} from "@thwip/migration-plan";
import {
  BASELINE_MIGRATION_FILE,
  testD1,
  type TestD1,
} from "../test/d1.js";
import { projectLifecycleRollout } from "./project-lifecycle.js";
import { databaseSchemaState } from "./schema-state.js";

const baselinePath = fileURLToPath(
  new URL(`../../../migrations-baseline/${BASELINE_MIGRATION_FILE}`, import.meta.url),
);
const syntheticFuture = {
  name: "1001_test_shared_future.sql",
  phase: "before-worker" as const,
  sql: `
    ALTER TABLE queue_clock ADD COLUMN future_migration_probe TEXT;
    CREATE INDEX queue_clock_future_migration_probe
      ON queue_clock(future_migration_probe) WHERE future_migration_probe IS NOT NULL;
  `,
};

const opened: TestD1[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function open(track: "legacy" | "baseline"): TestD1 {
  const test = testD1({ track });
  opened.push(test);
  return test;
}

function schemaObjects(raw: TestD1["raw"]) {
  return raw.prepare(
    `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END,
               name`,
  ).all();
}

function tableDetails(raw: TestD1["raw"]) {
  const tables = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    name,
    columns: raw.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(name),
    foreignKeys: raw.prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq").all(name),
    indexes: (raw.prepare("SELECT name, [unique], origin, partial FROM pragma_index_list(?) ORDER BY name").all(name) as Array<{ name: string }>).map((index) => ({
      ...index,
      columns: raw.prepare("SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno").all(index.name),
    })),
  }));
}

function nonEmptyApplicationTables(raw: TestD1["raw"]) {
  const tables = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) => {
    const row = raw.prepare(`SELECT count(*) AS count FROM "${name}"`).get() as { count: number };
    return row.count === 0 ? [] : [{ name, count: row.count }];
  });
}

function seedMeaning(raw: TestD1["raw"]) {
  return {
    retentionClock: raw.prepare(
      `SELECT id, claim_token AS claimToken, claim_expires_at AS claimExpiresAt,
              last_started_at AS lastStartedAt, last_finished_at AS lastFinishedAt,
              last_error_at AS lastErrorAt, last_error AS lastError
         FROM agent_report_retention_clock`,
    ).all(),
    rollout: raw.prepare(
      `SELECT maintenance_mode AS maintenanceMode,
              destructive_schema_ready_at IS NOT NULL AS cleanupReady,
              remote_capabilities_retired_at AS retiredAt,
              remote_capability_evidence AS retirementEvidence
         FROM project_lifecycle_rollout`,
    ).get(),
    r2Generation: raw.prepare(
      `SELECT generation, state, activated_at IS NOT NULL AS activated,
              retired_at AS retiredAt, retirement_evidence AS retirementEvidence
         FROM project_r2_capability_generations`,
    ).all(),
    queueClock: raw.prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt, source,
              last_error AS lastError, last_error_at AS lastErrorAt
         FROM queue_clock`,
    ).all(),
  };
}

function recordFuture(test: TestD1): void {
  test.raw.exec(syntheticFuture.sql);
  test.raw.prepare(
    "INSERT INTO d1_migrations (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(syntheticFuture.name);
}

describe("the public D1 baseline", () => {
  it("has exact steady-state schema parity with the complete private history", () => {
    const legacy = open("legacy");
    const baseline = open("baseline");

    expect(schemaObjects(baseline.raw)).toEqual(schemaObjects(legacy.raw));
    expect(tableDetails(baseline.raw)).toEqual(tableDetails(legacy.raw));
    expect(baseline.raw.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(legacy.raw.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(baseline.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(legacy.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("contains only generic state required by an empty control plane", async () => {
    const legacy = open("legacy");
    const baseline = open("baseline");
    const sql = readFileSync(baselinePath, "utf8");

    expect(nonEmptyApplicationTables(baseline.raw)).toEqual([
      { name: "agent_report_retention_clock", count: 1 },
      { name: "project_lifecycle_rollout", count: 1 },
      { name: "project_r2_capability_generations", count: 1 },
      { name: "queue_clock", count: 1 },
    ]);
    expect(seedMeaning(baseline.raw)).toEqual(seedMeaning(legacy.raw));
    expect(sql.match(/\bINSERT\s+INTO\s+([a-z0-9_]+)/gi)?.map((statement) => statement.toLowerCase())).toEqual([
      "insert into project_r2_capability_generations",
      "insert into project_lifecycle_rollout",
      "insert into queue_clock",
      "insert into agent_report_retention_clock",
    ]);
    expect(sql).not.toMatch(/recall|thwip\.ai|thwip-staging|1315419165|647114a5|00000000/i);
    expect(sql).not.toMatch(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+d1_migrations/i);
    expect(baseline.raw.prepare("SELECT * FROM project_lifecycle_backfills").all()).toEqual([]);

    await expect(projectLifecycleRollout(baseline.db)).resolves.toMatchObject({
      maintenanceMode: false,
      workerActivatedAt: null,
      workerBuildSha: null,
      workerDeploymentId: null,
      verifierV3PredeployId: null,
      backfillReady: true,
      cleanupReady: true,
    });
  });

  it("reports both supported ledgers as current with the same capabilities", async () => {
    const legacy = open("legacy");
    const baseline = open("baseline");
    const legacyState = await databaseSchemaState(legacy.db);
    const baselineState = await databaseSchemaState(baseline.db);

    expect(legacyState.release).toMatchObject({
      track: "legacy",
      phase: "current",
      capabilities: {
        projectLifecycle: true,
        lifecycleFinished: true,
        privateAgentFeedback: true,
        verifierProtocolV3: true,
        lifecycleReopened: true,
      },
    });
    expect(baselineState.release).toEqual({ ...legacyState.release, track: "baseline" });
    expect(baselineState.applied).toEqual([BASELINE_MIGRATION_RELEASE.name]);
  });

  it("applies one shared future migration to both tracks", () => {
    const legacy = open("legacy");
    const baseline = open("baseline");
    recordFuture(legacy);
    recordFuture(baseline);

    expect(schemaObjects(baseline.raw)).toEqual(schemaObjects(legacy.raw));
    expect(tableDetails(baseline.raw)).toEqual(tableDetails(legacy.raw));
    expect(baseline.raw.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(baseline.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const legacyModel = [...MIGRATION_RELEASES, syntheticFuture];
    const baselineModel = [...BASELINE_MIGRATION_RELEASES, syntheticFuture];
    expect(evaluateMigrationReleases(legacyModel, MIGRATION_RELEASES.map(({ name }) => name))).toMatchObject({
      kind: "before-worker",
      selected: [syntheticFuture.name],
    });
    expect(evaluateMigrationReleases(baselineModel, [BASELINE_MIGRATION_RELEASE.name])).toMatchObject({
      kind: "before-worker",
      selected: [syntheticFuture.name],
    });
    expect(evaluateMigrationReleases(legacyModel, legacyModel.map(({ name }) => name)).kind).toBe("current");
    expect(evaluateMigrationReleases(baselineModel, baselineModel.map(({ name }) => name)).kind).toBe("current");
  });

  it("fails closed if a ledger mixes the two starting tracks", () => {
    const applied = [BASELINE_MIGRATION_RELEASE.name, MIGRATION_RELEASES[0]!.name];
    const mixed = migrationReleaseState(applied);
    expect(migrationTrack(applied)).toBe("mixed");
    expect(mixed.kind).toBe("current");
    expect(mixed.outOfOrderApplied).toEqual([MIGRATION_RELEASES[0]!.name]);
  });
});
