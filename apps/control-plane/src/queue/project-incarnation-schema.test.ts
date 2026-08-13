import { afterEach, describe, expect, it } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";

const TABLES = [
  "queue_status_comments",
  "queue_runners",
  "queue_assignments",
  "candidate_dispatches",
  "candidate_verdicts",
  "queue_attestations",
  "queue_transitions_index",
  "queue_entries_index",
  "queue_projection_marks",
] as const;

const open: TestD1[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("repository-keyed queue ownership", () => {
  it.each(TABLES)("makes project_id mandatory on %s", (table) => {
    const t = testD1();
    open.push(t);
    const columns = t.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>;

    expect(columns.find((column) => column.name === "project_id")).toMatchObject({ notnull: 1 });
  });

  it.each(TABLES)("cascades %s through the exact project foreign key", (table) => {
    const t = testD1();
    open.push(t);
    const keys = t.raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;

    expect(keys).toContainEqual(
      expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }),
    );
  });
});
