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

function statements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function migrationStatements(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
  const all: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    all.push(...statements(readFileSync(join(dir, file), "utf8")));
  }
  return all;
}

export function testD1(): TestD1 {
  const raw = new Database(":memory:");
  for (const statement of migrationStatements()) {
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
