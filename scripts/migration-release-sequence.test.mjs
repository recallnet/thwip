import { describe, expect, it } from "vitest";
import { MIGRATION_RELEASES, migrationReleaseState } from "../packages/migration-plan/src/index.mjs";

const namesThrough = (last) => MIGRATION_RELEASES
  .map((migration) => migration.name)
  .filter((name) => name <= last);

describe("the supported 0028 to project-lifecycle reopen sequence", () => {
  it("makes every phase and barrier explicit without an old-SHA deployment", () => {
    expect(migrationReleaseState(namesThrough("0028_project_removal.sql"))).toMatchObject({
      kind: "before-worker",
      selected: ["0029_terminal_comment_priority.sql", "0030_github_repository_lifecycle.sql"],
      deployBlockers: ["0029_terminal_comment_priority.sql", "0030_github_repository_lifecycle.sql"],
      barrier: { name: "0031_finish_github_repository_lifecycle.sql" },
      blockedBehindBarrier: [
        "0032_private_agent_feedback_foundation.sql",
        "0033_verifier_protocol_v3.sql",
      ],
      outOfOrderApplied: [],
    });

    expect(migrationReleaseState(namesThrough("0030_github_repository_lifecycle.sql"))).toMatchObject({
      kind: "after-worker",
      selected: ["0031_finish_github_repository_lifecycle.sql"],
      deployBlockers: [],
      barrier: { id: "project-lifecycle-in-place" },
      blockedBehindBarrier: [
        "0032_private_agent_feedback_foundation.sql",
        "0033_verifier_protocol_v3.sql",
      ],
    });

    expect(migrationReleaseState(namesThrough("0029_terminal_comment_priority.sql"))).toMatchObject({
      kind: "before-worker",
      selected: ["0030_github_repository_lifecycle.sql"],
      deployBlockers: ["0030_github_repository_lifecycle.sql"],
    });

    expect(migrationReleaseState(namesThrough("0031_finish_github_repository_lifecycle.sql"))).toMatchObject({
      kind: "before-worker",
      selected: [
        "0032_private_agent_feedback_foundation.sql",
        "0033_verifier_protocol_v3.sql",
      ],
      deployBlockers: [
        "0032_private_agent_feedback_foundation.sql",
        "0033_verifier_protocol_v3.sql",
      ],
      barrier: { name: "0034_reopen_after_project_lifecycle.sql" },
    });

    expect(migrationReleaseState(namesThrough("0033_verifier_protocol_v3.sql"))).toMatchObject({
      kind: "after-worker",
      selected: ["0034_reopen_after_project_lifecycle.sql"],
      deployBlockers: [],
      barrier: { id: "project-lifecycle-reopen" },
      blockedBehindBarrier: [],
    });

    expect(migrationReleaseState(namesThrough("0032_private_agent_feedback_foundation.sql"))).toMatchObject({
      kind: "before-worker",
      selected: ["0033_verifier_protocol_v3.sql"],
      deployBlockers: ["0033_verifier_protocol_v3.sql"],
    });

    expect(migrationReleaseState(namesThrough("0034_reopen_after_project_lifecycle.sql"))).toMatchObject({
      kind: "current",
      selected: [],
      deployBlockers: [],
      barrier: null,
    });
  });

  it("refuses to normalize a ledger that skipped a known barrier", () => {
    const applied = namesThrough("0030_github_repository_lifecycle.sql").concat(
      "0032_private_agent_feedback_foundation.sql",
      "0033_verifier_protocol_v3.sql",
    );
    expect(migrationReleaseState(applied)).toMatchObject({
      kind: "after-worker",
      selected: ["0031_finish_github_repository_lifecycle.sql"],
      outOfOrderApplied: [
        "0032_private_agent_feedback_foundation.sql",
        "0033_verifier_protocol_v3.sql",
      ],
    });
  });
});
