import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  blockingMigrations,
  formatSchemaRefusal,
  parseDeployOrder,
  readMigrations,
  unappliedAgainst,
  undeclaredMigrations,
} from "./schema-guard.mjs";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * The deploy already refuses a checkout behind origin/main and already builds
 * before it ships. Nothing did the same for the database, and staging ran four
 * deploys against a schema missing 0020 and 0021 while the Worker that reads
 * `queue_runners` was live. Every `/authorize` under `fresh` answered
 * `500 no such table: queue_runners`, and nothing said so, because no
 * repository used that profile.
 */
describe("what every migration says about deploy order", () => {
  it("declares an order for every migration, so a new one cannot arrive silent", () => {
    const migrations = readMigrations(migrationsDir);
    expect(migrations.length).toBeGreaterThan(20);
    expect(undeclaredMigrations(migrations)).toEqual([]);
  });

  /**
   * 0018 is why this is a declaration and not a rule. It resolves a duplicate
   * chain link and then adds the unique index, and it has to land after the
   * Worker that carries the constraint catch. A blanket "migrate first" would
   * have been wrong for it.
   */
  it("keeps 0018 after its Worker and the tables 0020 and 0021 add before theirs", () => {
    const orders = new Map(readMigrations(migrationsDir).map((m) => [m.name, m.order]));
    expect(orders.get("0018_one_record_per_merge.sql")).toBe("after-worker");
    expect(orders.get("0020_queue_runners.sql")).toBe("before-worker");
    expect(orders.get("0021_local_run_assignments.sql")).toBe("before-worker");
  });

  it("reads the order out of the header and nothing else", () => {
    expect(parseDeployOrder("-- DEPLOY ORDER: before-worker\nCREATE TABLE t (a TEXT);")).toBe("before-worker");
    expect(parseDeployOrder("-- DEPLOY ORDER: after-worker\nCREATE TABLE t (a TEXT);")).toBe("after-worker");
    expect(parseDeployOrder("-- adds a table\nCREATE TABLE t (a TEXT);")).toBeNull();
    expect(parseDeployOrder("-- the worker goes before this, probably\nCREATE TABLE t (a TEXT);")).toBeNull();
  });
});

describe("which unapplied migrations refuse a deploy", () => {
  const migrations = [
    { name: "0001_first.sql", order: "before-worker" },
    { name: "0002_second.sql", order: "after-worker" },
    { name: "0003_third.sql", order: "before-worker" },
  ];

  it("refuses when the code's tables are not in the database yet", () => {
    expect(blockingMigrations(migrations, ["0003_third.sql"])).toEqual(["0003_third.sql"]);
  });

  it("lets a migration that belongs after its Worker stay unapplied", () => {
    expect(blockingMigrations(migrations, ["0002_second.sql"])).toEqual([]);
  });

  it("says nothing when the database is level with the code", () => {
    expect(blockingMigrations(migrations, [])).toEqual([]);
  });

  /**
   * The command it names is the repository's own, not a raw wrangler one.
   * Telling a person to type `wrangler d1 migrations apply` is telling them to
   * hold a credential that also runs `DELETE`, and it was the only remedy this
   * guard offered.
   */
  it("names every blocker and the command that applies them", () => {
    const message = formatSchemaRefusal(["0020_queue_runners.sql"], "staging");
    expect(message).toContain("0020_queue_runners.sql");
    expect(message).toContain("run migrate:staging");
    expect(message).not.toContain("wrangler d1");
  });
});

/**
 * The gate no longer asks wrangler what the database has; it asks the Worker,
 * which answers with what it has rather than with what is missing. Same
 * question, subtracted here instead of parsed out of a box-drawn table.
 */
describe("what is still pending, given what the database says it has", () => {
  const migrations = [
    { name: "0001_first.sql", order: "before-worker" },
    { name: "0002_second.sql", order: "after-worker" },
    { name: "0003_third.sql", order: "before-worker" },
  ];

  it("is every migration the database has not named", () => {
    expect(unappliedAgainst(migrations, ["0001_first.sql"])).toEqual(["0002_second.sql", "0003_third.sql"]);
  });

  it("is empty when the database has them all", () => {
    expect(unappliedAgainst(migrations, migrations.map((m) => m.name))).toEqual([]);
  });

  it("is everything when the database has never had a migration applied", () => {
    expect(unappliedAgainst(migrations, [])).toEqual(migrations.map((m) => m.name));
  });

  /**
   * A database ahead of this checkout is not this function's problem, and
   * reporting the extra name as pending would refuse a deploy that is fine.
   */
  it("ignores a migration the database has and this tree does not", () => {
    expect(unappliedAgainst(migrations, ["0001_first.sql", "0099_from_a_branch.sql"])).toEqual([
      "0002_second.sql",
      "0003_third.sql",
    ]);
  });
});
