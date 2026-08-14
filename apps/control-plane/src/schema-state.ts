import {
  publicMigrationState,
  schemaCapabilities,
  type PublicMigrationState,
  type SchemaCapabilities,
} from "@thwip/migration-plan";
import type { D1Like } from "./queue/projection.js";

/**
 * Which migrations this database has, from the Worker rather than from wrangler.
 *
 * `scripts/control-plane.mjs deploy` refuses code that needs a migration the
 * database does not have by reading this endpoint. The older gate ran
 * `wrangler d1 migrations list --remote`, making the deploy and the database
 * one authority: whoever could ship the Worker could also rewrite its tables,
 * and a second contributor could not be given one without the other.
 *
 * The Worker holds the binding already. Asking it turns the check into an
 * unauthenticated HTTP read, which is the whole reason a deploy no longer needs
 * a Cloudflare credential that can touch D1.
 *
 * Migration names are the schema's version and say nothing about any row, so
 * this is public in the same way `/health` publishes the build it is running.
 */
export async function appliedMigrations(db: D1Like): Promise<string[]> {
  return (await appliedMigrationRecords(db)).map((row) => row.name);
}

interface AppliedMigrationRecord {
  readonly name: string;
}

async function appliedMigrationRecords(db: D1Like): Promise<AppliedMigrationRecord[]> {
  try {
    const rows = await db
      .prepare("SELECT name FROM d1_migrations ORDER BY name")
      .bind()
      .all<AppliedMigrationRecord>();
    return rows.results;
  } catch (error) {
    // A database wrangler has never applied a migration to has no bookkeeping
    // table, and "nothing applied" is the true answer for it. Every other
    // failure is rethrown: an unreadable database read as an empty one is the
    // exact shape of the bug the deploy gate exists to catch.
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return [];
    throw error;
  }
}

export interface DatabaseSchemaState {
  readonly applied: readonly string[];
  readonly release: PublicMigrationState;
}

/** The public release and capability view derived from Wrangler's durable ledger. */
export async function databaseSchemaState(db: D1Like): Promise<DatabaseSchemaState> {
  const records = await appliedMigrationRecords(db);
  const applied = records.map((row) => row.name);
  return {
    applied,
    release: publicMigrationState(applied),
  };
}

/** Runtime feature gates use the same capability mapping as deploy and migrate. */
export async function databaseSchemaCapabilities(db: D1Like): Promise<SchemaCapabilities> {
  return schemaCapabilities(await appliedMigrations(db));
}
