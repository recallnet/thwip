#!/usr/bin/env node
/**
 * Read a row out of the live database, and only read.
 *
 * The database behind `thwip.ai` is the live one. There is no second
 * copy to practise on, and the documented way to look at it was
 * `wrangler d1 execute --remote --command "..."`, which is one word away from
 * `DELETE FROM mergeOperations`. Every mutation the product makes writes a
 * record naming who asked and why; a statement typed at that prompt writes
 * nothing, so a repair carried out that way is invisible the day after.
 *
 * Most of what anyone needs is already an HTTP call. `GET /v1/queue/:id/explain`
 * and `/heal` answer the queue questions, `/admin/schema` says which migrations
 * the live database has, and `scripts/verify-chain.mjs` checks the chain with no
 * credentials at all. See `docs/production-access.md`. This exists for the
 * reads that have no route yet, and it holds the line at reads.
 *
 * The deny list is the second lock, not the first. A statement has to open as a
 * read before the list is consulted, so a verb nobody thought to ban is refused
 * by the opening rather than waved through by the omission.
 *
 * Usage:  node scripts/d1.mjs "SELECT * FROM mergeOperations LIMIT 5"
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Verbs that change the database, or reach outside the one being read. */
const WRITES = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|REPLACE|TRUNCATE|VACUUM|REINDEX|DETACH|BEGIN|COMMIT|ROLLBACK)\b/i;

/** How a read opens. Everything else is somebody else's business. */
const READS = /^\s*(SELECT|WITH|EXPLAIN)\b/i;

/**
 * Why this statement will not be run, or null if it will be.
 *
 * Fails closed. `SELECT reason FROM x WHERE reason = 'delete'` is refused, and
 * that is the right trade: whoever wants it can widen the quoting themselves,
 * and nobody loses a table to a parser that thought it understood SQL.
 */
export function refuse(statement) {
  const sql = statement.trim();
  if (sql.length === 0) return "Nothing to run.";

  const body = sql.endsWith(";") ? sql.slice(0, -1) : sql;
  if (body.includes(";")) {
    return "Refusing: one statement at a time. A second statement is how a read turns into a write.";
  }

  const write = WRITES.exec(body);
  if (write !== null) {
    return (
      `Refusing: this statement contains ${write[1].toUpperCase()}, and this path only reads.\n` +
      "Mutations go through a route that records who asked and why. See docs/production-access.md."
    );
  }

  if (!READS.test(body)) {
    return "Refusing: a read starts with SELECT, WITH or EXPLAIN.";
  }

  return null;
}

/** The wrangler invocation, so a reader can see exactly what was asked. */
export function commandFor(statement, { database, env }) {
  return ["d1", "execute", database, "--env", env, "--remote", "--json", "--command", statement.trim()];
}

/** The database `wrangler.jsonc` binds for an environment, so nothing is typed twice. */
function databaseFor(env) {
  const config = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
  const json = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
  const binding = json.env?.[env]?.d1_databases?.find((db) => db.binding === "DB");
  if (binding === undefined) throw new Error(`wrangler.jsonc binds no DB for --env ${env}`);
  return binding.database_name;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let env = "staging";
  const rest = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") {
      env = args[i + 1] ?? "staging";
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  const statement = rest[0];

  if (statement === undefined) {
    console.error("usage: node scripts/d1.mjs [--env staging] \"SELECT ...\"");
    process.exit(2);
  }

  const refusal = refuse(statement);
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }

  const database = databaseFor(env);
  const argv = commandFor(statement, { database, env });
  console.error(`reading ${database} (${env}):\n  wrangler ${argv.join(" ")}\n`);
  execFileSync("wrangler", argv, { stdio: ["ignore", "inherit", "inherit"] });
}
