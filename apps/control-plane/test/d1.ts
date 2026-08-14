import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Like } from "../src/queue/projection.js";

/**
 * A real SQLite database with the real migrations, for tests.
 *
 * Outside `src` on purpose: everything under it is Worker source and may not
 * reach for node builtins, and this reads the migrations off disk.
 *
 * D1 is SQLite, so a test can run the schema the deployment runs rather than a
 * hand-kept copy that drifts. This exists as one function because the four test
 * files that each had their own copy also each had the same bug in it.
 *
 * Comments come out before the file is split into statements, not after. A
 * comment in one migration contains a semicolon — "the Durable Object is live
 * authority; these tables serve organization-wide reads" — and splitting first
 * cut the file mid-sentence, leaving a fragment that is not SQL and swallowing
 * the `CREATE TABLE` that followed it in the same chunk. `queue_projects` was
 * missing from every test database and nothing noticed, because no test had
 * needed it yet.
 */

export interface TestD1 {
  readonly db: D1Like;
  /** The underlying handle, for tests that need to set up or inspect rows. */
  readonly raw: Database.Database;
  close(): void;
}

export interface ActiveTestProject {
  readonly repositoryId: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly githubName?: string;
  readonly defaultBranch?: string;
  readonly enabled?: boolean;
}

/**
 * Seed the lifecycle owner of repository-keyed test state.
 *
 * Migration 0030 makes a live project incarnation a precondition for every
 * repository-keyed write. Tests that exercise queues, runners, attestations,
 * or projections therefore need the same organization and project records as
 * production. Keeping that setup here avoids another set of hand-written
 * lifecycle fixtures drifting from the real migrations.
 */
export function seedActiveProject(test: Pick<TestD1, "raw">, input: ActiveTestProject): string {
  const organizationId = input.organizationId ?? `org_${input.repositoryId}`;
  const projectId = input.projectId ?? `proj_${input.repositoryId}`;
  const githubName = input.githubName ?? `test/repository-${input.repositoryId}`;
  test.raw
    .prepare(
      `INSERT OR IGNORE INTO organizations (id, github_org_id, github_login, status)
       VALUES (?, ?, ?, 'active')`,
    )
    .run(organizationId, `github_${organizationId}`, `test-${organizationId}`);
  test.raw
    .prepare(
      `INSERT OR IGNORE INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      organizationId,
      input.repositoryId,
      githubName,
      input.defaultBranch ?? "main",
      input.enabled === false ? 0 : 1,
    );
  return projectId;
}

function statements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  // A trigger contains its own statement terminator before `END;`. Keep each
  // trigger whole rather than feeding SQLite the broken `CREATE ... BEGIN`
  // and `END` fragments produced by a plain semicolon split.
  const triggers = withoutComments.match(/CREATE TRIGGER[\s\S]*?END;/gi) ?? [];
  const ordinary = withoutComments.replace(/CREATE TRIGGER[\s\S]*?END;/gi, "");
  return ordinary
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .concat(triggers.map((trigger) => trigger.trim().replace(/;$/, "")));
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
const baselineMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations-baseline");
export const BASELINE_MIGRATION_FILE = "1000_current_schema.sql";

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export function migrationStatements(): string[] {
  const all: string[] = [];
  for (const file of migrationFiles()) all.push(...statements(readFileSync(join(migrationsDir, file), "utf8")));
  return all;
}

function runMigrationFile(raw: Database.Database, file: string, directory = migrationsDir): void {
  for (const statement of statements(readFileSync(join(directory, file), "utf8"))) {
    try {
      raw.exec(statement);
    } catch (error) {
      // A migration that alters a table an earlier one rebuilt, or drops
      // something absent, is expected to be a no-op here. Anything else is a
      // schema this test database would be wrong about, so it is not swallowed.
      const message = (error as Error).message;
      if (!/duplicate column|no such (table|column|index)|already exists/i.test(message)) {
        throw new Error(`migration statement failed: ${message}\n${statement.slice(0, 200)}`);
      }
    }
  }
}

/**
 * Run one migration file's statements against an already-open database, with
 * no swallowing: a test reaching for this wants to know whether that
 * migration's own statements succeed or fail, not have a later one's
 * "already exists" leniency mask it.
 *
 * For a migration that resolves bad data before adding a constraint, this is
 * how a test builds the bad data first — with `testD1({ upTo })` stopping
 * short of the file under test — and then runs exactly its statements to
 * check what they do to that data, rather than keeping a fourth private copy
 * of a migration loader.
 */
export function applyMigration(raw: Database.Database, file: string): void {
  for (const statement of statements(readFileSync(join(migrationsDir, file), "utf8"))) {
    raw.exec(statement);
  }
  recordMigration(raw, file);
}

function recordMigration(raw: Database.Database, file: string): void {
  raw.prepare(
    "INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(file);
}

export function testD1(options: {
  upTo?: string;
  rollout?: "steady" | "as-migrated";
  track?: "legacy" | "baseline";
} = {}): TestD1 {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  if (options.track === "baseline") {
    runMigrationFile(raw, BASELINE_MIGRATION_FILE, baselineMigrationsDir);
    recordMigration(raw, BASELINE_MIGRATION_FILE);
    // Later shared migrations live in the ordinary migration directory so the
    // hosted legacy track and the public baseline track execute the same file.
    for (const file of migrationFiles().filter((name) => name >= "1001_")) {
      runMigrationFile(raw, file);
      recordMigration(raw, file);
    }
  } else {
    for (const file of migrationFiles()) {
      if (options.upTo !== undefined && file >= options.upTo) break;
      // The finishing migration is allowed only after the lifecycle-aware Worker
      // has served for the compatibility window and the bounded backfill is
      // complete. Most tests model that ready state before applying 0031.
      if (file === "0031_finish_github_repository_lifecycle.sql") {
        raw.prepare(
          `UPDATE project_lifecycle_rollout
              SET maintenance_mode = 0,
                  worker_activated_at = '2000-01-01T00:00:00.000Z',
                  worker_build_sha = 'test-worker-build',
                  worker_deployment_id = '00000000-0000-4000-8000-000000000001',
                  destructive_schema_ready_at = NULL
            WHERE id = 1`,
        ).run();
      }
      runMigrationFile(raw, file);
      recordMigration(raw, file);
      if (file === "0033_verifier_protocol_v3.sql" && options.rollout !== "as-migrated") {
        // Most tests build the fully reopened steady state. Model the required
        // post-0033 deployment before the loader reaches 0034.
        raw.prepare(
          `UPDATE project_lifecycle_rollout
              SET worker_deployment_id = '00000000-0000-4000-8000-000000000099'
            WHERE id = 1`,
        ).run();
      }
    }
  }

  // Most tests model steady state after the in-place finishing schema. Rollout
  // tests clear these fields themselves.
  if (
    options.track !== "baseline" &&
    options.rollout !== "as-migrated" &&
    raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_lifecycle_rollout'")
      .get() !== undefined
  ) {
    raw.prepare(
      `UPDATE project_lifecycle_rollout
          SET worker_activated_at = '2000-01-01T00:00:00.000Z',
              worker_build_sha = 'test-worker-build',
              worker_deployment_id = '00000000-0000-4000-8000-000000000002',
              destructive_schema_ready_at = '2000-01-01T00:00:00.000Z'
        WHERE id = 1`,
    ).run();
  }

  const db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: raw.prepare(query).run(...(values as never[])).changes } }),
        first: async <T,>() => (raw.prepare(query).get(...(values as never[])) ?? null) as T | null,
        all: async <T,>() => ({ results: raw.prepare(query).all(...(values as never[])) as T[] }),
      }),
    }),
    batch: async (list: Array<{ run(): Promise<unknown> }>) => {
      for (const item of list) await item.run();
    },
  } as unknown as D1Like;

  return { db, raw, close: () => raw.close() };
}
