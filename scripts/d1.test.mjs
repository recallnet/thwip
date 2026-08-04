import { describe, expect, it } from "vitest";

import { commandFor, refuse } from "./d1.mjs";

/**
 * The documented way to look at production used to be `wrangler d1 execute`,
 * which is the same keystroke as `wrangler d1 execute --command "DELETE FROM
 * mergeOperations"`. Whoever holds credentials still needs to read rows
 * sometimes, so the read stays and the write goes: one statement, and it has to
 * be a read.
 */
describe("what the read path accepts", () => {
  it("takes a select", () => {
    expect(refuse("SELECT * FROM mergeOperations LIMIT 5")).toBeNull();
  });

  it("takes a common table expression, because that is how the interesting reads are written", () => {
    expect(refuse("WITH recent AS (SELECT * FROM chain) SELECT * FROM recent")).toBeNull();
  });

  it("does not care about case", () => {
    expect(refuse("select 1")).toBeNull();
  });

  it("takes a trailing semicolon, which is what a person pastes", () => {
    expect(refuse("SELECT 1;")).toBeNull();
  });

  it("takes an explain, which reads the plan and nothing else", () => {
    expect(refuse("EXPLAIN QUERY PLAN SELECT * FROM chain")).toBeNull();
  });
});

describe("what the read path refuses", () => {
  it("refuses a second statement, which is how a read becomes a write", () => {
    expect(refuse("SELECT 1; SELECT 2")).toMatch(/one statement/i);
  });

  it("refuses a write smuggled in behind a read", () => {
    expect(refuse("SELECT 1; DROP TABLE chain")).not.toBeNull();
  });

  for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "PRAGMA", "ATTACH"]) {
    it(`refuses ${verb}`, () => {
      expect(refuse(`${verb} something`)).not.toBeNull();
    });
  }

  it("refuses a write hiding in the middle of an otherwise readable statement", () => {
    expect(refuse("SELECT * FROM x WHERE id IN (DELETE FROM y RETURNING id)")).toMatch(/delete/i);
  });

  it("refuses anything that does not start as a read, so the deny list is not the only thing standing there", () => {
    expect(refuse("ANALYZE chain")).toMatch(/SELECT/);
  });

  it("refuses nothing at all", () => {
    expect(refuse("   ")).not.toBeNull();
  });

  /**
   * A deny list that fires on substrings refuses `created_at`, and a check that
   * cries wolf is one people route around. Word boundaries, so the column names
   * this database actually has still read.
   */
  it("reads a column whose name contains a refused word", () => {
    expect(refuse("SELECT created_at, updated_at FROM mergeOperations")).toBeNull();
  });
});

describe("what it runs", () => {
  it("names the database and the environment it is about to read", () => {
    const argv = commandFor("SELECT 1", { database: "thwip-staging-wnam", env: "staging" });
    expect(argv).toEqual([
      "d1",
      "execute",
      "thwip-staging-wnam",
      "--env",
      "staging",
      "--remote",
      "--json",
      "--command",
      "SELECT 1",
    ]);
  });
});
