import type { D1Like } from "./queue/projection.js";

/**
 * Which migrations this database has, from the Worker rather than from wrangler.
 *
 * `scripts/predeploy.mjs` refuses a deploy whose code needs a migration the
 * database does not have, and it used to establish that by running
 * `wrangler d1 migrations list --remote`. That made the deploy and the database
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
  try {
    const rows = await db
      .prepare("SELECT name FROM d1_migrations ORDER BY name")
      .bind()
      .all<{ name: string }>();
    return rows.results.map((row) => row.name);
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
