import { afterEach, describe, expect, it } from "vitest";

import { testD1 } from "../test/d1.js";
import { appliedMigrations, databaseSchemaState } from "./schema-state.js";

/**
 * Which migrations the live database has, answered by the Worker.
 *
 * The deploy gate used to ask this by shelling `wrangler d1 migrations list
 * --remote`, so the only way to check whether the schema was ready for the code
 * was to hold a credential that could also rewrite the schema. The Worker
 * already has the binding and already answers questions about itself, so it
 * answers this one and the deploy needs no database authority at all.
 */
const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function db() {
  const t = testD1();
  open.push(t);
  return t;
}

describe("what the database says it has", () => {
  it("names every migration wrangler recorded, in order", async () => {
    const t = db();
    t.raw.exec("DELETE FROM d1_migrations");
    t.raw.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run("0002_b.sql", "2026-01-02");
    t.raw.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run("0001_a.sql", "2026-01-01");

    expect(await appliedMigrations(t.db)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  /**
   * A database wrangler has never applied a migration to has no bookkeeping
   * table. Nothing has been applied, which is what the empty answer says, and
   * the deploy gate reads that as every migration pending and refuses. Fails
   * towards the refusal, which is the only direction this may fail in.
   */
  it("says nothing has been applied when the bookkeeping table was never created", async () => {
    const t = db();
    t.raw.exec("DROP TABLE d1_migrations");
    expect(await appliedMigrations(t.db)).toEqual([]);
  });

  it("publishes barrier and capability state from the shared release model", async () => {
    const t = testD1({ upTo: "0031_finish_github_repository_lifecycle.sql", rollout: "as-migrated" });
    open.push(t);
    await expect(databaseSchemaState(t.db)).resolves.toMatchObject({
      release: {
        phase: "after-worker",
        selected: ["0031_finish_github_repository_lifecycle.sql"],
        blockedBehindBarrier: [
          "0032_private_agent_feedback_foundation.sql",
          "0033_verifier_protocol_v3.sql",
        ],
        capabilities: {
          projectLifecycle: true,
          lifecycleFinished: false,
          privateAgentFeedback: false,
          verifierProtocolV3: false,
          lifecycleReopened: false,
        },
      },
    });
  });

  it("does not turn an unreadable database into an empty answer", async () => {
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: Network connection lost");
      },
    } as never;
    await expect(appliedMigrations(broken)).rejects.toThrow(/Network connection lost/);
  });
});
