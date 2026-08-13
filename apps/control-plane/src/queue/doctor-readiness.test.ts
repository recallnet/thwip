import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { BOOTSTRAP_STEPS } from "./rulesets.js";
import { readQueueDoctorReadiness } from "./doctor-readiness.js";

const REPOSITORY_ID = "1315419165";
const BASE_REF = "refs/heads/main";
const POLICY = `sha256:${"a".repeat(64)}`;
const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function database() {
  const t = testD1();
  open.push(t);
  t.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'acme')")
    .run();
  return t;
}

function seedProject(t: ReturnType<typeof testD1>, input: { id: string; enabled: 0 | 1; policy: string | null }) {
  t.raw
    .prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest)
       VALUES (?, 'org_1', ?, 'acme/repo', 'main', ?, ?)`,
    )
    .run(input.id, REPOSITORY_ID, input.enabled, input.policy);
  if (input.policy !== null) {
    t.raw
      .prepare(
        `INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status)
         VALUES (?, ?, 1, '{"version":1,"securityProfile":"fast"}', 'active')`,
      )
      .run(input.policy, input.id);
  }
}

function seedQueue(t: ReturnType<typeof testD1>, projectId: string, input: { enabled: 0 | 1; state: string }) {
  const progress = Object.fromEntries(BOOTSTRAP_STEPS.map((step) => [step, true]));
  t.raw
    .prepare(
      `INSERT INTO queue_projects
         (id, organization_id, github_repository_id, base_ref, enabled, activation_state,
          bootstrap_progress_json, verifier_workflow_version, project_id)
       VALUES (?, 'org_1', ?, ?, ?, ?, ?, 2, ?)`,
    )
    .run(`queue_${projectId}`, REPOSITORY_ID, BASE_REF, input.enabled, input.state, JSON.stringify(progress), projectId);
}

describe("doctor queue readiness", () => {
  it("reports a disabled current project instead of inferring health from queue state", async () => {
    const t = database();
    seedProject(t, { id: "project_disabled", enabled: 0, policy: POLICY });
    seedQueue(t, "project_disabled", { enabled: 1, state: "enforced" });

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toMatchObject({
      projectId: "project_disabled",
      projectEnabled: false,
      queueConfigured: true,
      queueEnabled: true,
    });
  });

  it("does not let a queue row from a removed incarnation satisfy a fresh project", async () => {
    const t = database();
    seedProject(t, { id: "project_old", enabled: 1, policy: POLICY });
    seedQueue(t, "project_old", { enabled: 1, state: "enforced" });

    // Phase 1 releases every child row before a re-add. This deletion models
    // that boundary, followed by the fresh disabled incarnation sync imports.
    t.raw.prepare("DELETE FROM queue_projects WHERE project_id = 'project_old'").run();
    t.raw.prepare("DELETE FROM policy_bundles WHERE project_id = 'project_old'").run();
    t.raw.prepare("DELETE FROM projects WHERE id = 'project_old'").run();
    seedProject(t, { id: "project_fresh", enabled: 0, policy: null });

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toEqual({
      projectId: "project_fresh",
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
      projectEnabled: false,
      activePolicyDigest: null,
      queueConfigured: false,
      queueEnabled: false,
      activationState: null,
      setupComplete: false,
    });
  });

  it("requires the exact branch queue to be enabled and fully bootstrapped", async () => {
    const t = database();
    seedProject(t, { id: "project_1", enabled: 1, policy: POLICY });
    seedQueue(t, "project_1", { enabled: 0, state: "observe" });

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toMatchObject({
      queueConfigured: true,
      queueEnabled: false,
      activationState: "observe",
      setupComplete: true,
    });
    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, "refs/heads/release")).resolves.toMatchObject({
      queueConfigured: false,
      queueEnabled: false,
      setupComplete: false,
    });
  });

  it("reports the healthy current incarnation and active remote policy digest", async () => {
    const t = database();
    seedProject(t, { id: "project_1", enabled: 1, policy: POLICY });
    seedQueue(t, "project_1", { enabled: 1, state: "enforced" });

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toEqual({
      projectId: "project_1",
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
      projectEnabled: true,
      activePolicyDigest: POLICY,
      queueConfigured: true,
      queueEnabled: true,
      activationState: "enforced",
      setupComplete: true,
    });
  });

  it("does not call a dangling or retired project digest active", async () => {
    const t = database();
    seedProject(t, { id: "project_1", enabled: 1, policy: POLICY });
    seedQueue(t, "project_1", { enabled: 1, state: "enforced" });
    t.raw.prepare("UPDATE policy_bundles SET status = 'retired' WHERE project_id = 'project_1'").run();

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toMatchObject({
      projectEnabled: true,
      activePolicyDigest: null,
    });
  });

  it("answers nothing while Phase 1 is releasing the current project", async () => {
    const t = database();
    seedProject(t, { id: "project_1", enabled: 1, policy: POLICY });
    seedQueue(t, "project_1", { enabled: 1, state: "enforced" });
    t.raw
      .prepare(
        `INSERT INTO project_release_requests
           (github_repository_id, project_id, organization_id, github_name, default_branch)
         VALUES (?, 'project_1', 'org_1', 'acme/repo', 'main')`,
      )
      .run(REPOSITORY_ID);

    await expect(readQueueDoctorReadiness(t.db, REPOSITORY_ID, BASE_REF)).resolves.toBeNull();
  });
});
