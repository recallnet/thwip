import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  describeMigrationNumberCollision,
  HISTORICAL_COLLISIONS,
  migrationNumberCollisions,
  readMigrationNumberCollisions,
} from "./migration-numbers.mjs";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const historicalNames = [...HISTORICAL_COLLISIONS.values()].flat();
const findingsFor = (...names) => migrationNumberCollisions([...historicalNames, ...names]);

describe("migration number collisions", () => {
  it("baselines the exact historic 0008 and 0023 filename pairs", () => {
    expect(readMigrationNumberCollisions(migrationsDir)).toEqual([]);
  });

  it("rejects a new duplicate number", () => {
    expect(findingsFor("0024_queue_clock.sql", "0024_another_clock.sql")).toEqual([
      {
        number: "0024",
        names: ["0024_another_clock.sql", "0024_queue_clock.sql"],
        baseline: null,
      },
    ]);
  });

  it("rejects adding a third filename to a historical collision", () => {
    const findings = findingsFor("0023_third.sql");
    expect(findings).toHaveLength(1);
    expect(findings[0].baseline).toHaveLength(2);
  });

  it("rejects renaming either applied file in a historical pair", () => {
    const withoutHistoric0008 = historicalNames.filter((name) => !name.startsWith("0008_"));
    expect(
      migrationNumberCollisions([
        ...withoutHistoric0008,
        "0008_policy_activation_source.sql",
        "0008_renamed_queue_projection.sql",
      ]),
    ).toHaveLength(1);
  });

  it("rejects deleting an entire historical pair", () => {
    const findings = migrationNumberCollisions([
      "0023_remove_queue_runtime_selectors.sql",
      "0023_status_comment_per_pull_request.sql",
    ]);
    expect(findings).toEqual([
      {
        number: "0008",
        names: [],
        baseline: ["0008_policy_activation_source.sql", "0008_queue_projection_serves_reads.sql"],
      },
    ]);
  });

  it("names every conflicting file and tells the author not to rename applied history", () => {
    const [finding] = findingsFor("0024_queue_clock.sql", "0024_another_clock.sql");
    const message = describeMigrationNumberCollision(finding);
    expect(message).toContain("migrations/0024_queue_clock.sql");
    expect(message).toContain("migrations/0024_another_clock.sql");
    expect(message).toContain("never rename an applied migration");
  });
});
