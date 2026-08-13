import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, seedActiveProject, testD1 } from "../../test/d1.js";

const MIGRATION = "0033_verifier_protocol_v3.sql";
const REPOSITORY = "1315419165";
const REF = "refs/heads/main";
const PROJECT = `proj_${REPOSITORY}`;

const open: Array<{ close(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("verifier protocol v3 migration", () => {
  it("keeps the old Worker schema contract on protocol v2 until explicit activation", () => {
    const t = testD1({ upTo: MIGRATION });
    open.push(t);
    seedActiveProject(t, { repositoryId: REPOSITORY });
    t.raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id)
         VALUES ('queue_1', ?, ?, ?, 1, 'enforced', ?)`,
      )
      .run(`org_${REPOSITORY}`, REPOSITORY, REF, PROJECT);

    applyMigration(t.raw, MIGRATION);

    // These are the column lists used by the pre-v3 Worker. Defaults keep them
    // valid after the migration while the project remains explicitly on v2.
    t.raw
      .prepare(
        `INSERT INTO candidate_dispatches
           (github_repository_id, base_ref, candidate_tree_oid, dispatched_at,
            project_id, attempt_id, workflow_protocol)
         VALUES (?, ?, ?, '2026-08-13T12:00:00.000Z', ?, 'attempt_1', 2)`,
      )
      .run(REPOSITORY, REF, "4".repeat(40), PROJECT);
    t.raw
      .prepare(
        `INSERT INTO candidate_verdicts
           (github_repository_id, base_ref, project_id, candidate_tree_oid,
            candidate_sha, base_sha, pull_request_number, accepted, result_digest,
            policy_digest, suites, reason_codes, workflow_ref, workflow_sha, run_id, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, 42, 1, ?, ?, '[]', '[]', ?, ?, 'run_1', '2026-08-13T12:01:00.000Z')`,
      )
      .run(
        REPOSITORY,
        REF,
        PROJECT,
        "4".repeat(40),
        "3".repeat(40),
        "1".repeat(40),
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
        "5".repeat(40),
      );

    expect(t.raw.prepare("SELECT verifier_protocol AS protocol FROM queue_projects").get()).toEqual({ protocol: 2 });
    expect(t.raw.prepare("SELECT verifier_protocol AS protocol FROM candidate_dispatches").get()).toEqual({ protocol: 2 });
    expect(t.raw.prepare("SELECT verifier_protocol AS protocol FROM candidate_verdicts").get()).toEqual({ protocol: 2 });

    t.raw.prepare("UPDATE queue_projects SET verifier_protocol = 3 WHERE id = 'queue_1'").run();
    expect(t.raw.prepare("SELECT terminal_reason AS reason FROM candidate_dispatches").get()).toEqual({
      reason: "superseded by verifier protocol v3",
    });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM candidate_verdicts").get()).toEqual({ count: 0 });
  });
});
