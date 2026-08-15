import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyMigration,
  testD1,
  type TestD1,
} from "../test/d1.js";
import type { Env } from "./env.js";
import {
  activateProjectLifecycleWorker,
  acquireProjectWriteLease,
  drainProjectLifecycleBackfill,
  drainProjectReleases,
  drainRepositoryAuthorityLeases,
  drainR2CleanupIntents,
  fenceDeselectedProjects,
  projectLifecycleRollout,
  reconcileInstalledProjects,
  releaseInstallationProjects,
  repositoryAcceptsProject,
} from "./project-lifecycle.js";
import { mergeLaneFor } from "./queue/merge-lane.js";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const REPO = "1319756073";
const OTHER_REPO = "555";
const PROJECT = "prj_old_incarnation";
const NAME = "example/project";
const open: TestD1[] = [];
const afterReimportQuarantine = () => new Date(Date.now() + 60 * 60_000 + 1);

function finishRollout(t: TestD1): void {
  t.raw
    .prepare(
      `UPDATE project_lifecycle_rollout
          SET worker_activated_at = '2000-01-01T00:00:00.000Z',
              destructive_schema_ready_at = '2000-01-01T00:00:00.000Z'
        WHERE id = 1`,
    )
    .run();
}

function authorizeFinishingMigration(t: TestD1): void {
  t.raw.prepare(
    `UPDATE project_lifecycle_rollout
        SET maintenance_mode = 0,
            worker_activated_at = '2000-01-01T00:00:00.000Z',
            destructive_schema_ready_at = NULL
      WHERE id = 1`,
  ).run();
}

function fixture() {
  const t = testD1();
  open.push(t);
  t.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, '991', 'recallnet', '44')")
    .run(ORG);
  t.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, '992', 'other', '45')")
    .run(OTHER_ORG);
  t.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES (?, ?, ?, ?, 'main', 1)",
    )
    .run(PROJECT, ORG, REPO, NAME);
  t.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('other_project', ?, ?, 'other/kept', 'main', 1)",
    )
    .run(OTHER_ORG, OTHER_REPO);

  const deleted: string[] = [];
  const purged: string[] = [];
  const env = {
    DB: t.db,
    EVIDENCE: {
      list: vi.fn(async ({ prefix }: { prefix: string }) =>
        prefix === `org/${ORG}/repo/${REPO}/`
        ? ({
          objects: [
            ...[
              "queue-decision",
              "integration-assignment",
              "integration-receipt",
              "verifier-result",
              "merge-intent",
              "transition-record",
            ].map((kind) => ({ key: `org/${ORG}/repo/${REPO}/${kind}/aa/${kind}` })),
          ],
          truncated: false,
        })
        : ({ objects: [], truncated: false })),
      delete: vi.fn(async (keys: string | string[]) => deleted.push(...(Array.isArray(keys) ? keys : [keys]))),
    },
    BRANCH_QUEUE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ purge: vi.fn(async () => purged.push(name)) }),
    },
  } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
  return { t, env, deleted, purged };
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  vi.restoreAllMocks();
});

describe("GitHub App repository lifecycle", () => {
  it("fences a full installation removal set in one bounded D1 batch", async () => {
    const t = testD1();
    open.push(t);
    t.raw.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '991', 'recallnet')",
    ).run(ORG);
    const insert = t.raw.prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled)
       VALUES (?, ?, ?, ?, 'main', 1)`,
    );
    const seed = t.raw.transaction(() => {
      for (let index = 0; index < 500; index += 1) {
        insert.run(`project-${index}`, ORG, String(50_000 + index), `recallnet/repo-${index}`);
      }
    });
    seed();
    let largestBatch = 0;
    const db = {
      ...t.db,
      batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
        largestBatch = Math.max(largestBatch, statements.length);
        if (statements.length > 100) throw new Error("D1 batch exceeded 100 statements");
        return t.db.batch!(statements as never);
      },
    };

    await expect(fenceDeselectedProjects(db as never, ORG, [])).resolves.toBe(500);
    expect(largestBatch).toBe(2);
    expect(t.raw.prepare("SELECT count(*) AS count FROM project_release_requests").get()).toEqual({ count: 500 });
    expect(t.raw.prepare("SELECT count(*) AS count FROM project_reimport_quarantines").get()).toEqual({ count: 500 });
  });

  it("fences every confirmed deselection before one active writer can delay cleanup", async () => {
    const { t, env } = fixture();
    const laterRepository = "9999999999";
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('later-project', ?, ?, 'recallnet/later', 'main', 1)",
    ).run(ORG, laterRepository);
    const writer = await acquireProjectWriteLease(t.db, REPO, PROJECT);
    expect(writer).not.toBeNull();
    await expect(reconcileInstalledProjects(env, ORG, [])).rejects.toThrow("active writes");
    expect(t.raw.prepare(
      "SELECT github_repository_id FROM project_release_requests WHERE organization_id = ? ORDER BY github_repository_id",
    ).all(ORG)).toEqual([
      { github_repository_id: REPO },
      { github_repository_id: laterRepository },
    ]);
    await expect(acquireProjectWriteLease(t.db, laterRepository, "later-project")).resolves.toBeNull();
    await writer!.release();
  });

  it("releases every project-scoped store while preserving shared tenant state", async () => {
    const { t, env, deleted, purged } = fixture();
    t.raw.prepare(
      `INSERT INTO github_repository_authority
         (github_repository_id, organization_id, installation_id, snapshot_id, selected)
       VALUES (?, ?, '44', 'deselection-snapshot', 0),
              (?, ?, '45', 'new-owner-snapshot', 1)`,
    ).run(REPO, ORG, REPO, OTHER_ORG);
    t.raw
      .prepare("INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES (?, '7', 'carson', 'admin')")
      .run(PROJECT);
    t.raw
      .prepare("INSERT INTO policy_bundles (digest, project_id, version, canonical_json) VALUES ('sha256:old', ?, 1, '{}')")
      .run(PROJECT);
    t.raw
      .prepare("INSERT INTO verification_observations (project_id, head_sha, outcome) VALUES (?, ?, 'passed')")
      .run(PROJECT, "a".repeat(40));
    t.raw.prepare(
      `INSERT INTO proof_verifications
       (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json, check_name)
       VALUES ('proof', ?, 'pull_request', ?, 'refs/heads/main', '1', 'observe', '{}', 'Thwip proof')`,
    ).run(PROJECT, "b".repeat(40));
    t.raw.prepare("INSERT INTO team_repos (organization_id, team_id, github_repository_id, permission) VALUES (?, 'team', ?, 'admin')").run(ORG, REPO);
    t.raw.prepare("INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, updated_at) VALUES (?, 'refs/heads/main', 1, 'now')").run(REPO);
    t.raw
      .prepare("INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, project_id) VALUES ('queue', ?, ?, 'refs/heads/release', 1, ?)")
      .run(ORG, REPO, PROJECT);
    t.raw.prepare("INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at, project_id) VALUES (?, 'refs/heads/main', 1, ?, 'now', ?)").run(REPO, JSON.stringify({ version: 1, inbox: { delivery: true }, diagnosticOutbox: [{ id: "outbox" }], deadlines: [{ kind: "merge-confirm" }], mergeOperations: [{ status: "unknown" }], events: [{ type: "Queued" }] }), PROJECT);
    t.raw
      .prepare("INSERT INTO queue_runners (github_repository_id, principal_id, device_key_id, last_heartbeat_at) VALUES (?, 'p', 'k', 'now')")
      .run(REPO);
    t.raw.prepare("INSERT INTO queue_assignments (assignment_id, github_repository_id, base_ref, attempt_id, assignment_digest, candidate_sha, candidate_tree_oid, principal_id, device_key_id, required_suites, execution_seconds, issued_at) VALUES ('assignment', ?, 'refs/heads/main', 'attempt', 'sha256:a', 'head', 'tree', 'p', 'k', '[]', 60, 'now')").run(REPO);
    t.raw.prepare("INSERT INTO candidate_dispatches (github_repository_id, base_ref, candidate_tree_oid, dispatched_at) VALUES (?, 'refs/heads/main', 'tree', 'now')").run(REPO);
    t.raw.prepare("INSERT INTO candidate_verdicts (github_repository_id, base_ref, candidate_tree_oid, candidate_sha, base_sha, pull_request_number, accepted, result_digest, policy_digest, suites, reason_codes, workflow_ref, workflow_sha, run_id, observed_at) VALUES (?, 'refs/heads/main', 'tree', 'head', 'base', 1, 1, 'sha256:r', 'sha256:p', '[]', '[]', 'wf', 'sha', 'run', 'now')").run(REPO);
    t.raw.prepare("INSERT INTO queue_attestations (digest, kind, github_repository_id, base_ref, bytes, jws) VALUES ('sha256:att', 'merge-intent', ?, 'refs/heads/main', '{}', 'jws')").run(REPO);
    t.raw.prepare("INSERT INTO queue_transitions_index (id, github_repository_id, base_ref, queue_epoch, transition_sequence, kind, digest, base_sha, observed_at) VALUES ('transition', ?, 'refs/heads/main', 0, 1, 'merge', 'sha256:att', 'base', 'now')").run(REPO);
    t.raw.prepare("INSERT INTO queue_entries_index (id, github_repository_id, base_ref, entry_id, pull_request_number, sponsor_principal_id, state, fairness_ordinal) VALUES ('entry', ?, 'refs/heads/main', 'entry', 1, 'p', 'Ready', '1')").run(REPO);
    t.raw.prepare("INSERT INTO queue_projection_marks (github_repository_id, base_ref, generation) VALUES (?, 'refs/heads/main', 1)").run(REPO);
    t.raw
      .prepare("INSERT INTO principals (id, organization_id, github_user_id, github_login) VALUES ('principal', ?, '7', 'carson')")
      .run(ORG);
    t.raw
      .prepare("INSERT INTO stripe_state (organization_id, stripe_customer_id) VALUES (?, 'cus_1')")
      .run(ORG);
    const privateReceiptId = "afr_project_removal";
    const privateRootId = "afp_project_removal";
    const privateLease = await acquireProjectWriteLease(t.db, REPO, PROJECT);
    expect(privateLease).not.toBeNull();
    t.raw.prepare(
      `INSERT INTO agent_report_receipts
         (id, status, created_at, updated_at, expires_at)
       VALUES (?, 'submitted', '2026-08-13T12:00:00.000Z',
               '2026-08-13T12:00:00.000Z', '2027-08-13T12:00:00.000Z')`,
    ).run(privateReceiptId);
    t.raw.prepare(
      `INSERT INTO agent_report_private_roots
         (id, receipt_id, project_id, payload_binding, submitted_at, delete_at)
       VALUES (?, ?, ?, ?, '2026-08-13T12:00:00.000Z', '2026-11-11T12:00:00.000Z')`,
    ).run(privateRootId, privateReceiptId, PROJECT, `hmac-sha256:v1:${"a".repeat(64)}`);
    t.raw.prepare(
      `INSERT INTO agent_report_content (private_root_id, kind, title, description)
       VALUES (?, 'bug', 'Queue status is unclear',
               'The status does not explain what the user should do next.')`,
    ).run(privateRootId);
    t.raw.prepare(
      `INSERT INTO agent_report_provenance
         (private_root_id, better_auth_user_id, github_user_id, github_installation_id,
          github_repository_id, cli_version, accepted_at)
       VALUES (?, 'better-auth-carson', '7', '44', ?, '0.1.0', '2026-08-13T12:00:00.000Z')`,
    ).run(privateRootId, REPO);
    t.raw.prepare(
      `INSERT INTO agent_report_events (id, private_root_id, action, actor_role, occurred_at)
       VALUES ('afe_project_removal', ?, 'submitted', 'submitter', '2026-08-13T12:00:00.000Z')`,
    ).run(privateRootId);
    await privateLease!.release();

    expect(await releaseInstallationProjects(env, ORG)).toBe(1);

    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM repository_grants WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM policy_bundles WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM queue_projects WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM queue_runners WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    for (const table of [
      "team_repos", "queue_status_comments", "queue_assignments", "candidate_dispatches", "candidate_verdicts",
      "queue_attestations", "queue_transitions_index", "queue_entries_index", "queue_projection_marks", "queue_state",
    ]) {
      expect(t.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE github_repository_id = ?`).get(REPO)).toEqual({ n: 0 });
    }
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM proof_verifications WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM agent_report_private_roots WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    for (const table of ["agent_report_content", "agent_report_provenance", "agent_report_events"]) {
      expect(t.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(t.raw.prepare(
      `SELECT status, final_at IS NOT NULL AS final, content_deleted_at IS NOT NULL AS contentDeleted
         FROM agent_report_receipts WHERE id = ?`,
    ).get(privateReceiptId)).toEqual({ status: "closed", final: 1, contentDeleted: 1 });
    expect(JSON.stringify(t.raw.prepare(
      "SELECT * FROM agent_report_receipts WHERE id = ?",
    ).get(privateReceiptId))).not.toMatch(/1319756073|prj_old_incarnation|carson|recallnet/i);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_jobs").get()).toEqual({ n: 0 });
    expect(t.raw.prepare(
      `SELECT organization_id, installation_id, selected
         FROM github_repository_authority WHERE github_repository_id = ?`,
    ).all(REPO)).toEqual([{ organization_id: OTHER_ORG, installation_id: "45", selected: 1 }]);
    expect(t.raw.prepare("SELECT github_name FROM projects WHERE id = 'other_project'").get()).toEqual({ github_name: "other/kept" });
    expect(t.raw.prepare("SELECT github_login FROM principals WHERE id = 'principal'").get()).toEqual({ github_login: "carson" });
    expect(t.raw.prepare("SELECT stripe_customer_id FROM stripe_state WHERE organization_id = ?").get(ORG)).toEqual({ stripe_customer_id: "cus_1" });
    expect(deleted).toHaveLength(6);
    // Each branch removes the exact old-project object and its retired legacy
    // repository/ref object.
    expect(purged).toHaveLength(4);
    expect(purged.filter((name) => name.startsWith(`project/${PROJECT}/repo/${REPO}/ref/`))).toHaveLength(2);
    expect(t.raw.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps a transient release job after failure and re-selection starts clean", async () => {
    const { t, env } = fixture();
    await expect(
      reconcileInstalledProjects(env, ORG, [], {
        beforeD1Cleanup: async () => {
          throw new Error("injected");
        },
      }),
    ).rejects.toThrow("injected");
    expect(t.raw.prepare("SELECT project_id FROM project_release_jobs WHERE github_repository_id = ?").get(REPO)).toEqual({
      project_id: PROJECT,
    });
    expect(await repositoryAcceptsProject(t.db, REPO, PROJECT)).toBe(false);

    // GitHub selected it again before cleanup finished. Old state is released
    // first, then one fresh disabled incarnation is imported.
    await reconcileInstalledProjects(env, ORG, [{ id: REPO, fullName: NAME, defaultBranch: "main" }], {
      now: afterReimportQuarantine,
    });
    const fresh = t.raw
      .prepare("SELECT id, enabled, active_policy_digest FROM projects WHERE github_repository_id = ?")
      .get(REPO) as { id: string; enabled: number; active_policy_digest: string | null };
    expect(fresh.id).not.toBe(PROJECT);
    expect(fresh).toMatchObject({ enabled: 0, active_policy_digest: null });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_jobs").get()).toEqual({ n: 0 });
  });

  it("retries terminated R2 compensation and preserves a fresh project's object", async () => {
    const { t, env } = fixture();
    const oldKey = `project/${PROJECT}/org/${ORG}/repo/${REPO}/queue-decision/aa/old`;
    const objects = new Set([oldKey]);
    let failOldDelete = true;
    const bucket = {
      async list({ prefix }: { prefix: string }) {
        const matching = [...objects].filter((key) => key.startsWith(prefix));
        return { objects: matching.map((key) => ({ key })), truncated: false };
      },
      async delete(keys: string | string[]) {
        const selected = Array.isArray(keys) ? keys : [keys];
        if (failOldDelete && selected.includes(oldKey)) {
          failOldDelete = false;
          throw new Error("injected compensation failure");
        }
        for (const key of selected) objects.delete(key);
      },
      async head(key: string) {
        return objects.has(key) ? { size: 1 } : null;
      },
    };
    const lifecycleEnv = { ...env, EVIDENCE: bucket };
    // The writer ended without its postcheck. Its expired intent remains even
    // if the release later deletes the project row.
    t.raw.prepare(
      `INSERT INTO project_r2_cleanup_intents
         (object_key, project_id, organization_id, github_repository_id,
          state, owner_token, lease_expires_at)
       VALUES (?, ?, ?, ?, 'writing', 'dead-writer', '2000-01-01T00:00:00.000Z')`,
    ).run(oldKey, PROJECT, ORG, REPO);

    await expect(reconcileInstalledProjects(lifecycleEnv, ORG, [])).rejects.toThrow(/R2 writes/);
    expect(objects.has(oldKey)).toBe(true);
    expect(t.raw.prepare("SELECT state FROM project_r2_cleanup_intents WHERE object_key = ?").get(oldKey)).toEqual({
      state: "cleanup",
    });

    await expect(reconcileInstalledProjects(lifecycleEnv, ORG, [])).resolves.toMatchObject({ released: 1 });
    expect(objects.has(oldKey)).toBe(false);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_r2_cleanup_intents").get()).toEqual({ n: 0 });

    await reconcileInstalledProjects(lifecycleEnv, ORG, [{ id: REPO, fullName: NAME, defaultBranch: "main" }], {
      now: afterReimportQuarantine,
    });
    const fresh = t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(REPO) as { id: string };
    const freshKey = `project/${fresh.id}/org/${ORG}/repo/${REPO}/queue-decision/bb/fresh`;
    objects.add(freshKey);
    t.raw.prepare(
      `INSERT INTO project_r2_cleanup_intents
         (object_key, project_id, organization_id, github_repository_id,
          state, owner_token, lease_expires_at)
       VALUES (?, ?, ?, ?, 'writing', 'ended-fresh-writer', '2000-01-01T00:00:00.000Z')`,
    ).run(freshKey, fresh.id, ORG, REPO);

    await expect(drainR2CleanupIntents(lifecycleEnv)).resolves.toMatchObject({ preserved: 1, failed: 0 });
    expect(objects.has(freshKey)).toBe(true);
    expect(objects.has(oldKey)).toBe(false);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_r2_cleanup_intents").get()).toEqual({ n: 0 });
  });

  it("keeps an expired pre-put intent fenced through the bounded abandoned-writer grace", async () => {
    const { t, env } = fixture();
    const oldKey = `project/${PROJECT}/org/${ORG}/repo/${REPO}/queue-decision/aa/paused`;
    const objects = new Set<string>();
    const lifecycleEnv = {
      ...env,
      EVIDENCE: {
        async list({ prefix }: { prefix: string }) {
          return { objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
        },
        async delete(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
        },
        async head(key: string) {
          return objects.has(key) ? { size: 1 } : null;
        },
      },
    };
    t.raw.prepare(
      `INSERT INTO project_r2_cleanup_intents
         (object_key, project_id, organization_id, github_repository_id,
          capability_generation, state, owner_token, lease_expires_at)
       VALUES (?, ?, ?, ?, 'phase-1-existing-bucket', 'writing', 'paused-put', '2030-01-01T00:00:00.000Z')`,
    ).run(oldKey, PROJECT, ORG, REPO);

    // Lease expiry alone cannot claim that a paused external put ended. Release
    // remains fenced even though no object is visible yet.
    await expect(drainR2CleanupIntents(lifecycleEnv as never, {
      now: new Date("2030-01-01T00:30:00.000Z"),
    })).resolves.toMatchObject({ attempted: 0 });
    await expect(reconcileInstalledProjects(lifecycleEnv as never, ORG, [])).rejects.toThrow(/R2 writes/);
    expect(t.raw.prepare("SELECT state FROM project_r2_cleanup_intents WHERE object_key = ?").get(oldKey)).toEqual({
      state: "writing",
    });

    // The original put now commits and its invocation terminates before the
    // postcheck. The durable exact-key intent still holds the release fence.
    objects.add(oldKey);
    await expect(drainR2CleanupIntents(lifecycleEnv as never, {
      now: new Date("2030-01-01T00:59:59.999Z"),
    })).resolves.toMatchObject({ attempted: 0 });
    await expect(reconcileInstalledProjects(lifecycleEnv as never, ORG, [])).rejects.toThrow(/R2 writes/);

    // One hour after the renewable lease expired, the drainer may treat the
    // writer as terminated. It deletes the exact old-incarnation key in the
    // existing bucket and release can finish without replacing storage.
    await expect(drainR2CleanupIntents(lifecycleEnv as never, {
      now: new Date("2030-01-01T01:00:00.000Z"),
    })).resolves.toMatchObject({ cleaned: 1, failed: 0 });
    await expect(reconcileInstalledProjects(lifecycleEnv as never, ORG, [])).resolves.toMatchObject({ released: 1 });
    expect(objects.has(oldKey)).toBe(false);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_r2_cleanup_intents").get()).toEqual({ n: 0 });
  });

  it("fences a stale cleanup owner before it can purge fresh evidence after re-selection", async () => {
    const { t, env, deleted } = fixture();
    let freshProjectId = "";
    let freshLease: Awaited<ReturnType<typeof acquireProjectWriteLease>> = null;
    const freshEvidenceKey = `org/${ORG}/repo/${REPO}/transition-record/fresh`;

    await expect(
      reconcileInstalledProjects(env, ORG, [], {
        beforeEvidenceCleanup: async () => {
          // Model this cleanup invocation pausing long enough to lose its
          // durable claim. Another invocation then finishes the same release
          // and authoritative sync imports a fresh incarnation.
          t.raw
            .prepare(
              "UPDATE project_release_jobs SET cleanup_lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE github_repository_id = ?",
            )
            .run(REPO);
          await reconcileInstalledProjects(env, ORG, [
            { id: REPO, fullName: NAME, defaultBranch: "main" },
          ], { now: afterReimportQuarantine });
          const fresh = t.raw
            .prepare("SELECT id FROM projects WHERE github_repository_id = ?")
            .get(REPO) as { id: string };
          freshProjectId = fresh.id;
          expect(freshProjectId).not.toBe(PROJECT);
          t.raw
            .prepare(
              "INSERT INTO team_repos (organization_id, team_id, github_repository_id, permission) VALUES (?, 'fresh-team', ?, 'admin')",
            )
            .run(ORG, REPO);
          freshLease = await acquireProjectWriteLease(t.db, REPO, freshProjectId);
          expect(freshLease).not.toBeNull();
          vi.mocked(env.EVIDENCE.list).mockResolvedValue({
            objects: [{ key: freshEvidenceKey }],
            truncated: false,
          });
        },
      }),
    ).rejects.toThrow("cleanup is owned by another release worker");

    expect(t.raw.prepare("SELECT id FROM projects WHERE id = ?").get(freshProjectId)).toEqual({ id: freshProjectId });
    expect(t.raw.prepare("SELECT team_id FROM team_repos WHERE github_repository_id = ?").get(REPO)).toEqual({
      team_id: "fresh-team",
    });
    await expect(freshLease!.renew()).resolves.toBeUndefined();
    expect(deleted).toHaveLength(6);
    expect(deleted).not.toContain(freshEvidenceKey);
    await freshLease!.release();
  });

  it("cannot let a paused old-prefix delete remove evidence from a fresh incarnation", async () => {
    const { t, env } = fixture();
    const oldKey = `project/${PROJECT}/org/${ORG}/repo/${REPO}/transition-record/old`;
    const objects = new Set([oldKey]);
    let oldDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { oldDeleteStarted = resolve; });
    let finishOldDelete!: () => void;
    const mayFinishOldDelete = new Promise<void>((resolve) => { finishOldDelete = resolve; });
    let paused = false;
    (env as unknown as { EVIDENCE: unknown }).EVIDENCE = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (keys: string | string[]) => {
        const batch = Array.isArray(keys) ? keys : [keys];
        if (!paused && batch.includes(oldKey)) {
          paused = true;
          oldDeleteStarted();
          await mayFinishOldDelete;
        }
        for (const key of batch) objects.delete(key);
      },
    };

    const staleCleanup = reconcileInstalledProjects(env, ORG, []);
    await deleteStarted;
    t.raw.prepare(
      "UPDATE project_release_jobs SET cleanup_lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE github_repository_id = ?",
    ).run(REPO);

    // A new cleanup owner finishes the old release and imports a new project.
    await reconcileInstalledProjects(env, ORG, [{ id: REPO, fullName: NAME, defaultBranch: "main" }], {
      now: afterReimportQuarantine,
    });
    const fresh = t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(REPO) as { id: string };
    expect(fresh.id).not.toBe(PROJECT);
    const freshKey = `project/${fresh.id}/org/${ORG}/repo/${REPO}/transition-record/fresh`;
    objects.add(freshKey);

    finishOldDelete();
    await expect(staleCleanup).rejects.toThrow("cleanup is owned by another release worker");
    expect(objects.has(freshKey)).toBe(true);
    expect(objects.has(oldKey)).toBe(false);
  });

  it("makes a stale global-drainer snapshot a no-op after cleanup and re-selection", async () => {
    const { t, env, deleted } = fixture();
    await expect(
      reconcileInstalledProjects(env, ORG, [], {
        beforeD1Cleanup: async () => {
          throw new Error("pause the first cleanup");
        },
      }),
    ).rejects.toThrow("pause the first cleanup");

    let selected!: () => void;
    const didSelect = new Promise<void>((resolve) => {
      selected = resolve;
    });
    let resume!: () => void;
    const mayResume = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const staleDrain = drainProjectReleases(env, 10, {
      afterDrainSelected: async () => {
        selected();
        await mayResume;
      },
    });
    await didSelect;

    // Another release worker finishes the selected row, then authoritative
    // GitHub sync imports a clean incarnation before the stale snapshot runs.
    await reconcileInstalledProjects(env, ORG, [
      { id: REPO, fullName: NAME, defaultBranch: "main" },
    ], { now: afterReimportQuarantine });
    const fresh = t.raw
      .prepare("SELECT id FROM projects WHERE github_repository_id = ?")
      .get(REPO) as { id: string };
    expect(fresh.id).not.toBe(PROJECT);
    t.raw
      .prepare(
        "INSERT INTO team_repos (organization_id, team_id, github_repository_id, permission) VALUES (?, 'fresh-team', ?, 'admin')",
      )
      .run(ORG, REPO);
    const freshLease = await acquireProjectWriteLease(t.db, REPO, fresh.id);
    expect(freshLease).not.toBeNull();
    const freshEvidenceKey = `org/${ORG}/repo/${REPO}/transition-record/fresh`;
    vi.mocked(env.EVIDENCE.list).mockResolvedValue({
      objects: [{ key: freshEvidenceKey }],
      truncated: false,
    });
    const deletesBeforeResume = deleted.length;

    resume();
    await expect(staleDrain).resolves.toEqual({ attempted: 1, released: 0, failed: 0 });
    expect(t.raw.prepare("SELECT id FROM projects WHERE id = ?").get(fresh.id)).toEqual({ id: fresh.id });
    expect(t.raw.prepare("SELECT team_id FROM team_repos WHERE github_repository_id = ?").get(REPO)).toEqual({
      team_id: "fresh-team",
    });
    await expect(freshLease!.renew()).resolves.toBeUndefined();
    expect(deleted).toHaveLength(deletesBeforeResume);
    expect(deleted).not.toContain(freshEvidenceKey);
    await freshLease!.release();
  });

  it("makes bounded progress across R2 pages and resumes from the release request", async () => {
    const { t, env, deleted } = fixture();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [{ key: `org/${ORG}/repo/${REPO}/page-one` }], truncated: true })
      .mockResolvedValueOnce({ objects: [{ key: `org/${ORG}/repo/${REPO}/page-two` }], truncated: false })
      .mockResolvedValueOnce({ objects: [], truncated: false });
    (env.EVIDENCE as unknown as { list: typeof list }).list = list;

    await expect(releaseInstallationProjects(env, ORG)).rejects.toThrow("more evidence to purge");
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_requests").get()).toEqual({ n: 1 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(PROJECT)).toEqual({ n: 1 });

    await expect(releaseInstallationProjects(env, ORG)).resolves.toBe(1);
    expect(deleted).toEqual([
      `org/${ORG}/repo/${REPO}/page-one`,
      `org/${ORG}/repo/${REPO}/page-two`,
    ]);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_requests").get()).toEqual({ n: 0 });
  });

  it("purges only orphan staging rows from before the exact project release", async () => {
    const { t, env } = fixture();
    t.raw.prepare(
      "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, created_at) VALUES ('old-snapshot', ?, '44', '2000-01-01T00:00:00.000Z')",
    ).run(ORG);
    t.raw.prepare(
      "INSERT INTO github_sync_grants (snapshot_id, github_repository_id, project_id, github_user_id, github_login, permission) VALUES ('old-snapshot', ?, ?, '7', 'old', 'admin')",
    ).run(REPO, PROJECT);
    t.raw.prepare(
      "INSERT INTO github_sync_team_repos (snapshot_id, team_id, github_repository_id, project_id, permission) VALUES ('old-snapshot', 'old-team', ?, ?, 'admin')",
    ).run(REPO, PROJECT);

    await reconcileInstalledProjects(env, ORG, [], {
      afterMarked: async () => {
        // A later same-tenant snapshot and a different tenant's snapshot are
        // not residue from this release. A stale cleaner must leave both.
        t.raw.prepare(
          "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, created_at) VALUES ('fresh-snapshot', ?, '44', '2099-01-01T00:00:00.000Z')",
        ).run(ORG);
        t.raw.prepare(
          "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, created_at) VALUES ('foreign-snapshot', ?, '45', '2000-01-01T00:00:00.000Z')",
        ).run(OTHER_ORG);
        for (const snapshot of ["fresh-snapshot", "foreign-snapshot"]) {
          t.raw.prepare(
            "INSERT INTO github_sync_grants (snapshot_id, github_repository_id, project_id, github_user_id, github_login, permission) VALUES (?, ?, ?, '9', 'fresh', 'admin')",
          ).run(snapshot, REPO, snapshot === "fresh-snapshot" ? "future_project" : "other_project");
          t.raw.prepare(
            "INSERT INTO github_sync_team_repos (snapshot_id, team_id, github_repository_id, project_id, permission) VALUES (?, 'fresh-team', ?, ?, 'admin')",
          ).run(snapshot, REPO, snapshot === "fresh-snapshot" ? "future_project" : "other_project");
        }
      },
    });

    expect(t.raw.prepare(
      "SELECT snapshot_id FROM github_sync_grants WHERE github_repository_id = ? ORDER BY snapshot_id",
    ).all(REPO)).toEqual([
      { snapshot_id: "foreign-snapshot" },
      { snapshot_id: "fresh-snapshot" },
    ]);
    expect(t.raw.prepare(
      "SELECT snapshot_id FROM github_sync_team_repos WHERE github_repository_id = ? ORDER BY snapshot_id",
    ).all(REPO)).toEqual([
      { snapshot_id: "foreign-snapshot" },
      { snapshot_id: "fresh-snapshot" },
    ]);
  });

  it("resumes Durable Object cleanup at the first unpurged branch", async () => {
    const { t, env } = fixture();
    t.raw.prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, project_id) VALUES ('queue', ?, ?, 'refs/heads/release', 1, ?)",
    ).run(ORG, REPO, PROJECT);
    const purged: string[] = [];
    let failed = false;
    let calls = 0;
    (env.BRANCH_QUEUE as unknown as { get(name: string): { purge(): Promise<void> } }).get = (name) => ({
      async purge() {
        calls += 1;
        if (!failed && calls === 2) {
          failed = true;
          throw new Error("injected Durable Object failure");
        }
        purged.push(name);
      },
    });

    await expect(releaseInstallationProjects(env, ORG)).rejects.toThrow("injected Durable Object failure");
    // The second purge is the legacy object for main. The exact-project row
    // stays durable until both identities are gone.
    expect(t.raw.prepare("SELECT project_id, base_ref FROM project_release_queue_refs ORDER BY base_ref").all()).toEqual([
      { project_id: PROJECT, base_ref: "refs/heads/main" },
      { project_id: PROJECT, base_ref: "refs/heads/release" },
    ]);
    await expect(releaseInstallationProjects(env, ORG)).resolves.toBe(1);
    expect(purged).toHaveLength(5);
    expect(purged.filter((name) => name.startsWith("project/")).every((name) =>
      name.startsWith(`project/${PROJECT}/repo/${REPO}/ref/`)
    )).toBe(true);
    expect(purged).not.toContain(`project/fresh-project/repo/${REPO}/ref/refs%2Fheads%2Fmain`);
  });

  it("waits for an earlier project writer and rejects the old incarnation after re-add", async () => {
    const { t, env } = fixture();
    const lease = await acquireProjectWriteLease(t.db, REPO, PROJECT);
    expect(lease?.projectId).toBe(PROJECT);
    await expect(reconcileInstalledProjects(env, ORG, [])).rejects.toThrow("active writes");
    expect(await acquireProjectWriteLease(t.db, REPO, PROJECT)).toBeNull();
    expect(await repositoryAcceptsProject(t.db, REPO, PROJECT)).toBe(false);
    await expect(lease!.renew()).resolves.toBeUndefined();
    await lease!.release();
    await reconcileInstalledProjects(env, ORG, []);
    await reconcileInstalledProjects(env, ORG, [{ id: REPO, fullName: NAME, defaultBranch: "main" }], {
      now: afterReimportQuarantine,
    });
    expect(await acquireProjectWriteLease(t.db, REPO, PROJECT)).toBeNull();
  });

  it("imports a clean re-selection only at the one-hour capability boundary", async () => {
    const { t, env } = fixture();
    await reconcileInstalledProjects(env, ORG, []);
    const quarantine = t.raw.prepare(
      "SELECT reimport_not_before AS notBefore FROM project_reimport_quarantines WHERE github_repository_id = ?",
    ).get(REPO) as { notBefore: string };
    const deadline = Date.parse(quarantine.notBefore);

    await expect(reconcileInstalledProjects(
      env,
      ORG,
      [{ id: REPO, fullName: NAME, defaultBranch: "main" }],
      { now: () => new Date(deadline - 1) },
    )).resolves.toEqual({ released: 0, imported: 0 });
    expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(REPO)).toBeUndefined();

    await expect(reconcileInstalledProjects(
      env,
      ORG,
      [{ id: REPO, fullName: NAME, defaultBranch: "main" }],
      { now: () => new Date(deadline) },
    )).resolves.toEqual({ released: 0, imported: 1 });
    const fresh = t.raw.prepare(
      "SELECT id, enabled FROM projects WHERE github_repository_id = ?",
    ).get(REPO) as { id: string; enabled: number };
    expect(fresh).toMatchObject({ enabled: 0 });
    expect(fresh.id).not.toBe(PROJECT);
  });

  it("independently collects only expired never-reselected quarantines after the finishing schema", async () => {
    const { t, env } = fixture();
    const now = new Date("2030-01-01T02:00:00.000Z");
    t.raw.prepare(
      `INSERT INTO project_reimport_quarantines
         (github_repository_id, prior_project_id, organization_id, reimport_not_before)
       VALUES ('orphan-expired', 'old-expired', ?, '2030-01-01T01:00:00.000Z'),
              ('orphan-unexpired', 'old-unexpired', ?, '2030-01-01T03:00:00.000Z'),
              (?, 'other_project', ?, '2030-01-01T01:00:00.000Z')`,
    ).run(ORG, ORG, OTHER_REPO, OTHER_ORG);
    t.raw.prepare(
      "UPDATE project_lifecycle_rollout SET destructive_schema_ready_at = NULL WHERE id = 1",
    ).run();

    await expect(drainProjectReleases(env, 10, { now: () => now }))
      .resolves.toEqual({ attempted: 0, released: 0, failed: 0 });
    expect(t.raw.prepare(
      "SELECT github_repository_id FROM project_reimport_quarantines ORDER BY github_repository_id",
    ).all()).toEqual([
      { github_repository_id: OTHER_REPO },
      { github_repository_id: "orphan-expired" },
      { github_repository_id: "orphan-unexpired" },
    ]);

    finishRollout(t);
    await expect(drainProjectReleases(env, 10, { now: () => now }))
      .resolves.toEqual({ attempted: 0, released: 0, failed: 0 });
    expect(t.raw.prepare(
      "SELECT github_repository_id FROM project_reimport_quarantines ORDER BY github_repository_id",
    ).all()).toEqual([
      { github_repository_id: OTHER_REPO },
      { github_repository_id: "orphan-unexpired" },
    ]);
  });

  it("keeps the release fence until the in-place finishing schema is installed", async () => {
    const { t, env, deleted } = fixture();
    t.raw.prepare(
      `UPDATE project_lifecycle_rollout
          SET worker_activated_at = NULL, remote_capabilities_retired_at = NULL,
              remote_capability_evidence = NULL, destructive_schema_ready_at = NULL
        WHERE id = 1`,
    ).run();
    const deployedAt = new Date("2026-08-12T10:00:00.000Z");
    await activateProjectLifecycleWorker(
      t.db,
      "test-build",
      "00000000-0000-4000-8000-000000000003",
      deployedAt,
    );

    await expect(
      reconcileInstalledProjects(env, ORG, [], { now: () => deployedAt }),
    ).resolves.toEqual({ released: 0, imported: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM project_release_requests").get()).toEqual({ count: 1 });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(PROJECT)).toEqual({ count: 1 });
    expect(deleted).toEqual([]);

    // A clock advance cannot unlock cleanup by itself. Migration 0031 must
    // install the mandatory incarnation schema and record its marker.
    await expect(
      reconcileInstalledProjects(env, ORG, [], {
        now: () => new Date(deployedAt.getTime() + 365 * 24 * 60 * 60_000),
      }),
    ).resolves.toEqual({ released: 0, imported: 0 });
    await expect(reconcileInstalledProjects(env, ORG, [])).resolves.toEqual({ released: 0, imported: 0 });
    finishRollout(t);
    await expect(projectLifecycleRollout(t.db)).resolves.toMatchObject({
      cleanupReady: true,
    });

    // Model old residue in the existing bucket when the finishing schema
    // allows cleanup.
    (env.EVIDENCE as unknown as { list(options: { prefix: string }): Promise<unknown> }).list = vi.fn()
      .mockImplementation(async ({ prefix }) => ({
        objects: prefix === `org/${ORG}/repo/${REPO}/`
          ? [{ key: `org/${ORG}/repo/${REPO}/transition-record/old` }]
          : [],
        truncated: false,
      }));
    await expect(
      reconcileInstalledProjects(env, ORG, [], {
        now: () => deployedAt,
      }),
    ).resolves.toEqual({ released: 1, imported: 0 });
    expect(deleted).toEqual([`org/${ORG}/repo/${REPO}/transition-record/old`]);
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM project_release_requests").get()).toEqual({ count: 0 });
  });

  it("backfills project incarnations in bounded crash-safe pages before the finishing migration", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '991', 'recallnet')",
    ).run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(PROJECT, ORG, REPO, NAME);
    const insert = t.raw.prepare(
      "INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at) VALUES (?, ?, 1, '{}', 'now')",
    );
    const seed = t.raw.transaction(() => {
      for (let index = 0; index < 750; index += 1) insert.run(REPO, `refs/heads/test-${index}`);
    });
    seed();
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");

    let ready = false;
    let calls = 0;
    while (!ready) {
      const result = await drainProjectLifecycleBackfill(t.db, 500);
      expect(result.updated).toBeLessThanOrEqual(500);
      ready = result.ready;
      calls += 1;
      if (calls > 20) throw new Error("bounded lifecycle backfill made no progress");
    }
    expect(calls).toBeGreaterThan(11);
    expect(t.raw.prepare("SELECT count(*) AS count FROM queue_state WHERE project_id IS NULL").get())
      .toEqual({ count: 0 });
    expect(t.raw.prepare("SELECT verified_row_count FROM project_lifecycle_backfills WHERE table_name = 'queue_state'").get())
      .toEqual({ verified_row_count: 750 });

    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    expect(t.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(t.raw.prepare(
      "SELECT generation, state FROM project_r2_capability_generations ORDER BY generation",
    ).all()).toEqual([
      { generation: "phase-1-existing-bucket", state: "active" },
    ]);
  });

  it("refuses the finishing migration while a bounded backfill is incomplete", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '991', 'recallnet')",
    ).run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(PROJECT, ORG, REPO, NAME);
    const insert = t.raw.prepare(
      "INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at) VALUES (?, ?, 1, '{}', 'now')",
    );
    for (let index = 0; index < 2; index += 1) insert.run(REPO, `refs/heads/pending-${index}`);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    authorizeFinishingMigration(t);
    expect(() => applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql")).toThrow();
  });

  it("freshly refuses row 25,001 after a completed bounded backfill before rebuilding tables", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '991', 'recallnet')",
    ).run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(PROJECT, ORG, REPO, NAME);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    t.raw.exec(
      `WITH RECURSIVE rows(value) AS (
         VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000
       )
       INSERT INTO queue_state
         (github_repository_id, base_ref, generation, document, updated_at)
       SELECT '${REPO}', printf('refs/heads/reviewed-%05d', value), 1, '{}', 'now'
         FROM rows`,
    );

    let ready = false;
    while (!ready) ready = (await drainProjectLifecycleBackfill(t.db, 500)).ready;
    expect(t.raw.prepare(
      "SELECT completed_at IS NOT NULL AS complete, verified_row_count FROM project_lifecycle_backfills WHERE table_name = 'queue_state'",
    ).get()).toEqual({ complete: 1, verified_row_count: 25_000 });

    // This row is compatible and its additive-migration trigger supplies the
    // project id. Only a fresh count at the destructive boundary can catch it.
    t.raw.prepare(
      "INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at) VALUES (?, 'refs/heads/late', 1, '{}', 'now')",
    ).run(REPO);
    authorizeFinishingMigration(t);
    expect(() => applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql"))
      .toThrow("CHECK constraint failed");
    expect(t.raw.prepare("SELECT count(*) AS count FROM queue_state").get()).toEqual({ count: 25_001 });
    expect(t.raw.prepare("PRAGMA table_info(queue_state)").all().find(
      (column) => (column as { name: string }).name === "project_id",
    )).toMatchObject({ notnull: 0 });
  }, 30_000);

  it("refuses the finishing migration before the Worker compatibility window", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    expect(() => applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql"))
      .toThrow("CHECK constraint failed");
    expect(t.raw.prepare("SELECT maintenance_mode, destructive_schema_ready_at FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance_mode: 0, destructive_schema_ready_at: null });
  });

  it("checks the durable release request immediately before a branch write", async () => {
    const { t } = fixture();
    let writes = 0;
    const lease = await acquireProjectWriteLease(t.db, REPO, PROJECT);
    expect(lease).not.toBeNull();
    const lane = mergeLaneFor(
      {
        projectWriteLease: async () => ({
          projectId: PROJECT,
          renew: async () => {
            t.raw.prepare(
              "INSERT OR IGNORE INTO project_release_requests (github_repository_id, project_id, organization_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
            ).run(REPO, PROJECT, ORG, NAME);
          },
          release: async () => lease!.release(),
        }),
        mergeWrite: async () => {
          writes += 1;
          return { kind: "unknown" as const, detail: "not reached" };
        },
      } as never,
      async () => {
        throw new Error("queue should not move before a cancelled branch write");
      },
    );

    await expect(lane.performMergeFromWorker({ DB: t.db } as never, {
      repositoryId: REPO,
      projectId: PROJECT,
      baseRef: "refs/heads/main",
      attemptId: "attempt",
      operationId: "operation",
      pullRequestNumber: 1,
      merge: { baseSha: "base", headSha: "head", treeOid: "tree", parentShas: ["base", "head"] },
    })).resolves.toMatchObject({ merged: false, reason: "PROJECT_RELEASE_REQUESTED" });
    expect(writes).toBe(0);
  });

  it("is idempotent and does not change another organization", async () => {
    const { t, env } = fixture();
    const selected = [{ id: REPO, fullName: NAME, defaultBranch: "main" }];
    expect(await reconcileInstalledProjects(env, ORG, selected)).toEqual({ released: 0, imported: 0 });
    expect(await reconcileInstalledProjects(env, ORG, selected)).toEqual({ released: 0, imported: 0 });
    expect(t.raw.prepare("SELECT enabled FROM projects WHERE github_repository_id = ?").get(OTHER_REPO)).toEqual({ enabled: 1 });
  });

  it.each(["old-first", "new-first"])("moves a transferred repository between tenants in %s sync order", async (order) => {
    const { t, env } = fixture();
    const selected = [
      { id: REPO, fullName: "other/transferred", defaultBranch: "trunk" },
      { id: OTHER_REPO, fullName: "other/kept", defaultBranch: "main" },
    ];
    if (order === "old-first") {
      await reconcileInstalledProjects(env, ORG, []);
      await reconcileInstalledProjects(env, OTHER_ORG, selected);
      await reconcileInstalledProjects(env, OTHER_ORG, selected, { now: afterReimportQuarantine });
    } else {
      await reconcileInstalledProjects(env, OTHER_ORG, selected);
      await reconcileInstalledProjects(env, ORG, []);
      await reconcileInstalledProjects(env, OTHER_ORG, selected, { now: afterReimportQuarantine });
    }
    const transferred = t.raw.prepare(
      "SELECT organization_id, github_name, default_branch, enabled FROM projects WHERE github_repository_id = ?",
    ).get(REPO);
    expect(transferred).toEqual({ organization_id: OTHER_ORG, github_name: "other/transferred", default_branch: "trunk", enabled: 0 });
    expect(t.raw.prepare("SELECT github_name FROM projects WHERE github_repository_id = ?").get(OTHER_REPO)).toEqual({ github_name: "other/kept" });
  });

  it("removes obsolete permanent tombstone and audit schema", () => {
    const { t } = fixture();
    expect(t.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'removed_projects'").get()).toBeUndefined();
    expect(t.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_deletion_audits'").get()).toBeUndefined();
    expect(
      t.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'removed_project_blocks_%'").get(),
    ).toEqual({ n: 0 });
  });

  it("does not publish the superseded dashboard-only remove and restore workflow", () => {
    const faq = readFileSync(new URL("../web/public/faq.md", import.meta.url), "utf8");
    expect(faq).toContain("Remove the repository from the Thwip GitHub App installation");
    expect(faq).toContain("there is no separate Thwip removal step");
    expect(faq).not.toMatch(/type its full `OWNER\/REPOSITORY`|will not restore it during a GitHub sync|Explicitly adding/);
  });

  it("keeps the old Worker safe between the additive and finishing migrations", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '123', 'legacy')").run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(PROJECT, ORG, REPO, NAME);

    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");

    // The still-live old Worker omits project_id. The additive migration fills
    // it, and the legacy tombstone tables remain readable until the new Worker
    // has deployed.
    t.raw.prepare(
      "INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at) VALUES (?, 'refs/heads/main', 1, '{}', 'now')",
    ).run(REPO);
    expect(t.raw.prepare("SELECT project_id FROM queue_state WHERE github_repository_id = ?").get(REPO)).toEqual({
      project_id: PROJECT,
    });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM removed_projects").get()).toEqual({ n: 0 });

    t.raw.prepare(
      "INSERT INTO project_release_requests (github_repository_id, project_id, organization_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(REPO, PROJECT, ORG, NAME);
    t.raw.prepare(
      "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, updated_at) VALUES (?, 'refs/heads/main', 1, 'now')",
    ).run(REPO);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM queue_status_comments WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    t.raw.prepare(
      "INSERT INTO verification_observations (project_id, head_sha, outcome) VALUES (?, ?, 'PASS')",
    ).run(PROJECT, "a".repeat(40));
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM verification_observations WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });

    // Simulate an old manual removal that lands after 0030. The finishing
    // migration converts this last tombstone before dropping the legacy table.
    t.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES (?, ?, '2026-08-02T00:00:00Z', '7')",
    ).run(ORG, REPO);
    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    expect(t.raw.prepare("SELECT project_id FROM project_release_jobs WHERE github_repository_id = ?").get(REPO)).toEqual({
      project_id: PROJECT,
    });
    expect(
      t.raw.prepare("SELECT prefix FROM project_release_evidence_scopes WHERE github_repository_id = ? ORDER BY prefix").all(REPO),
    ).toEqual([
      { prefix: `org/${ORG}/repo/${REPO}/` },
      { prefix: `project/${PROJECT}/` },
    ]);
    expect(t.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'removed_projects'").get()).toBeUndefined();
    expect(t.raw.pragma("foreign_key_list(verification_observations)")).toContainEqual(
      expect.objectContaining({ table: "projects", from: "project_id", to: "id", on_delete: "CASCADE" }),
    );
    expect(t.raw.pragma("foreign_key_check")).toEqual([]);
  });

  it("fences every old D1 table mutation and keeps traffic closed through the in-place rebuild", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '123', 'legacy')").run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
    ).run(PROJECT, ORG, REPO, NAME);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    t.raw.prepare(
      "INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at) VALUES (?, 'refs/heads/main', 1, '{}', 'now')",
    ).run(REPO);

    const tables = t.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', 'project_lifecycle_rollout') ORDER BY name")
      .all() as Array<{ name: string }>;
    const triggers = new Set(
      (t.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'project_lifecycle_maintenance_%'")
        .all() as Array<{ name: string }>).map(({ name }) => name),
    );
    for (const { name } of tables) {
      for (const operation of ["insert", "update", "delete"]) {
        expect(triggers, `${name} has no ${operation} maintenance fence`).toContain(
          `project_lifecycle_maintenance_${name}_${operation}`,
        );
      }
    }

    t.raw.prepare(
      "UPDATE project_lifecycle_rollout SET maintenance_mode = 1 WHERE id = 1",
    ).run();
    expect(() => t.raw.prepare("UPDATE queue_state SET document = '{\"old\":true}' WHERE github_repository_id = ?").run(REPO))
      .toThrow("project lifecycle maintenance is active");
    expect(() => t.raw.prepare("DELETE FROM queue_state WHERE github_repository_id = ?").run(REPO))
      .toThrow("project lifecycle maintenance is active");
    expect(() => t.raw.prepare(
      "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, updated_at) VALUES (?, 'refs/heads/main', 1, 'now')",
    ).run(REPO)).toThrow("project lifecycle maintenance is active");
    expect(t.raw.prepare("SELECT document FROM queue_state WHERE github_repository_id = ?").get(REPO)).toEqual({ document: "{}" });

    // Migration 0031 removes the source guards before its in-place table
    // rebuilds. The Worker-level gate remains active until 0034 reopens
    // traffic.
    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    expect(t.raw.prepare("SELECT maintenance_mode, destructive_schema_ready_at FROM project_lifecycle_rollout").get())
      .toEqual({ maintenance_mode: 1, destructive_schema_ready_at: expect.any(String) });
    expect(t.raw.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'project_lifecycle_maintenance_%'",
    ).get()).toEqual({ n: 0 });
    // Direct SQL has no Worker-level gate. The service itself remains closed,
    // and 0034's guarded final statement is the only supported reopen.
  });

  it("blocks the old manual restore endpoint during the two-phase migration window", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '123', 'legacy')").run(ORG);
    t.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES (?, ?, '2026-08-01T00:00:00Z', '7')",
    ).run(ORG, REPO);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");

    // The retired endpoint deletes the tombstone and then inserts its
    // deterministic project id in one batch. The additive lifecycle request
    // must make that INSERT fail instead of reviving an enabled incarnation
    // that the synthetic legacy job cannot name.
    const restore = t.raw.transaction(() => {
      t.raw.prepare("DELETE FROM removed_projects WHERE organization_id = ? AND github_repository_id = ?").run(ORG, REPO);
      t.raw.prepare(
        `INSERT INTO projects
           (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES (?, ?, ?, ?, 'main', 1)`,
      ).run(`prj_gh_${REPO}`, ORG, REPO, NAME);
    });
    expect(restore).toThrow("repository release is still in progress");
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM projects WHERE github_repository_id = ?").get(REPO)).toEqual({ count: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM removed_projects WHERE github_repository_id = ?").get(REPO)).toEqual({ count: 1 });
  });

  it("captures a removal created after the additive migration before the old Worker can restore it", () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '123', 'legacy')").run(ORG);
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES (?, ?, ?, ?, 'main', 1)",
    ).run(PROJECT, ORG, REPO, NAME);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");

    // This is the marker written by the still-live old removal endpoint. The
    // additive trigger must capture the real incarnation before that endpoint
    // deletes the project row.
    t.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES (?, ?, '2026-08-03T00:00:00Z', '7')",
    ).run(ORG, REPO);
    expect(t.raw.prepare("SELECT project_id FROM project_release_jobs WHERE github_repository_id = ?").get(REPO)).toEqual({
      project_id: PROJECT,
    });
    t.raw.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT);

    const restore = t.raw.transaction(() => {
      t.raw.prepare("DELETE FROM removed_projects WHERE organization_id = ? AND github_repository_id = ?").run(ORG, REPO);
      t.raw.prepare(
        `INSERT INTO projects
           (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES (?, ?, ?, ?, 'main', 1)`,
      ).run(`prj_gh_${REPO}`, ORG, REPO, NAME);
    });
    expect(restore).toThrow("repository release is still in progress");
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM projects WHERE github_repository_id = ?").get(REPO)).toEqual({ count: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM removed_projects WHERE github_repository_id = ?").get(REPO)).toEqual({ count: 1 });
  });

  it("captures a late old-tenant tombstone without touching the transferred project", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_old', '123', 'old')").run();
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_new', '124', 'new')").run();
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('prj_new', 'org_new', ?, 'new/repo', 'main', 0)",
    ).run(REPO);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");

    t.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org_old', ?, '2026-08-03T00:00:00Z', '7')",
    ).run(REPO);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_jobs WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT organization_id FROM project_legacy_cleanup_scopes WHERE github_repository_id = ?").get(REPO)).toEqual({ organization_id: "org_old" });

    const oldRestore = t.raw.transaction(() => {
      t.raw.prepare("DELETE FROM removed_projects WHERE organization_id = 'org_old' AND github_repository_id = ?").run(REPO);
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('prj_old_restore', 'org_old', ?, 'old/repo', 'main', 1)",
      ).run(REPO);
    });
    expect(oldRestore).toThrow("repository release is still in progress");

    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    finishRollout(t);
    const prefixes: string[] = [];
    const env = {
      DB: t.db,
      EVIDENCE: {
        list: async ({ prefix }: { prefix: string }) => {
          prefixes.push(prefix);
          return { objects: [], truncated: false };
        },
        delete: async () => undefined,
      },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
    await expect(drainProjectReleases(env)).resolves.toEqual({ attempted: 1, released: 1, failed: 0 });
    expect(prefixes).toEqual([`org/org_old/repo/${REPO}/`]);
    expect(t.raw.prepare("SELECT id, organization_id FROM projects WHERE github_repository_id = ?").get(REPO)).toEqual({
      id: "prj_new",
      organization_id: "org_new",
    });
  });

  it("migrates and drains a legacy tombstone whose project row was already gone", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, '123', 'legacy')").run(ORG);
    t.raw.prepare("INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES (?, ?, '2026-08-01T00:00:00Z', '7')").run(ORG, REPO);
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    finishRollout(t);
    expect(t.raw.prepare("SELECT organization_id FROM project_legacy_cleanup_scopes WHERE github_repository_id = ?").get(REPO)).toEqual({ organization_id: ORG });
    const env = {
      DB: t.db,
      EVIDENCE: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;

    await expect(drainProjectReleases(env)).resolves.toEqual({ attempted: 1, released: 1, failed: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_requests").get()).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_jobs").get()).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_legacy_cleanup_scopes").get()).toEqual({ n: 0 });
  });

  it("globally drains migrated jobs for disconnected organizations and isolates retries", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    for (const [organizationId, repositoryId] of [["org_disconnected_a", "701"], ["org_disconnected_b", "702"]]) {
      t.raw
        .prepare("INSERT INTO organizations (id, github_org_id, github_login, status) VALUES (?, ?, ?, 'disconnected')")
        .run(organizationId, repositoryId, organizationId);
      t.raw.prepare(
        "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES (?, ?, '2026-08-01T00:00:00Z', '7')",
      ).run(organizationId, repositoryId);
    }
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    finishRollout(t);
    let firstFails = true;
    const env = {
      DB: t.db,
      EVIDENCE: {
        async list({ prefix }: { prefix: string }) {
          if (prefix.includes("/repo/701/") && firstFails) {
            firstFails = false;
            throw new Error("one tenant R2 read failed");
          }
          return { objects: [], truncated: false };
        },
        delete: async () => undefined,
      },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(drainProjectReleases(env)).resolves.toEqual({ attempted: 2, released: 1, failed: 1 });
    expect(t.raw.prepare("SELECT github_repository_id FROM project_legacy_cleanup_scopes").all()).toEqual([
      { github_repository_id: "701" },
    ]);
    await expect(drainProjectReleases(env)).resolves.toEqual({ attempted: 1, released: 1, failed: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM project_legacy_cleanup_scopes").get()).toEqual({ count: 0 });
  });

  it("gives legacy cleanup bounded progress when ordinary releases keep failing", async () => {
    const t = testD1();
    open.push(t);
    finishRollout(t);
    for (const repositoryId of ["801", "802"]) {
      const organizationId = `org_${repositoryId}`;
      const projectId = `project_${repositoryId}`;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, status) VALUES (?, ?, ?, 'disconnected')",
      ).run(organizationId, repositoryId, organizationId);
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, 'main')",
      ).run(projectId, organizationId, repositoryId, `${organizationId}/repo`);
      t.raw.prepare(
        `INSERT INTO project_release_requests
           (github_repository_id, project_id, organization_id, github_name, default_branch, requested_at)
         VALUES (?, ?, ?, ?, 'main', '2000-01-01T00:00:00.000Z')`,
      ).run(repositoryId, projectId, organizationId, `${organizationId}/repo`);
    }
    t.raw.prepare(
      `INSERT INTO project_legacy_cleanup_scopes
         (github_repository_id, organization_id, started_at)
       VALUES ('899', 'org_legacy', '2000-01-02T00:00:00.000Z')`,
    ).run();
    const visited: string[] = [];
    const env = {
      DB: t.db,
      EVIDENCE: {
        async list({ prefix }: { prefix: string }) {
          visited.push(prefix);
          if (prefix.includes("/repo/801/") || prefix.includes("/repo/802/")) {
            throw new Error("ordinary cleanup remains unavailable");
          }
          return { objects: [], truncated: false };
        },
        delete: async () => undefined,
      },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(drainProjectReleases(env, 2)).resolves.toEqual({ attempted: 2, released: 0, failed: 2 });
    await expect(drainProjectReleases(env, 2)).resolves.toMatchObject({ attempted: 2, released: 1 });
    expect(visited).toContain("org/org_legacy/repo/899/");
    expect(t.raw.prepare(
      "SELECT COUNT(*) AS n FROM project_legacy_cleanup_scopes WHERE github_repository_id = '899'",
    ).get()).toEqual({ n: 0 });
  });

  it("garbage-collects only expired repository leases with no lifecycle owner", async () => {
    const t = testD1();
    open.push(t);
    finishRollout(t);
    const now = new Date("2026-08-13T12:00:00.000Z");
    const expired = "2026-08-13T11:00:00.000Z";
    const future = "2026-08-13T13:00:00.000Z";
    for (const [repositoryId, installationId, expiresAt] of [
      ["lease_orphan", "700", expired],
      ["lease_future", "701", future],
      ["lease_project", "702", expired],
      ["lease_authority", "703", expired],
      ["lease_quarantine", "704", expired],
      ["lease_snapshot", "705", expired],
      ["lease_intent", "706", expired],
      ["lease_legacy", "707", expired],
      ["lease_sync", "708", expired],
      ["lease_release", "709", expired],
      ["lease_writer", "710", expired],
    ] as const) {
      t.raw.prepare(
        `INSERT INTO github_repository_reconcile_leases
           (github_repository_id, installation_id, owner_token, epoch, expires_at)
         VALUES (?, ?, 'old-owner', 4, ?)`,
      ).run(repositoryId, installationId, expiresAt);
    }
    t.raw.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('lease_org', '702', 'lease-org', '702')",
    ).run();
    t.raw.prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch)
       VALUES ('lease_project_id', 'lease_org', 'lease_project', 'lease-org/repo', 'main')`,
    ).run();
    t.raw.prepare(
      `INSERT INTO github_repository_authority
         (github_repository_id, organization_id, installation_id, snapshot_id, selected)
       VALUES ('lease_authority', 'lease_org', '703', 'authority-snapshot', 0)`,
    ).run();
    t.raw.prepare(
      `INSERT INTO project_reimport_quarantines
         (github_repository_id, prior_project_id, organization_id, reimport_not_before)
       VALUES ('lease_quarantine', 'old-project', 'lease_org', ?)`,
    ).run(expired);
    t.raw.prepare(
      `INSERT INTO github_sync_snapshots
         (id, organization_id, installation_id, owner_token)
       VALUES ('lease-snapshot', 'lease_org', '705', 'snapshot-owner')`,
    ).run();
    t.raw.prepare(
      `INSERT INTO project_r2_cleanup_intents
         (object_key, project_id, organization_id, github_repository_id,
          state, owner_token, lease_expires_at)
       VALUES ('project/old/evidence', 'old-project', 'lease_org', 'lease_intent',
               'cleanup', 'writer', ?)`,
    ).run(expired);
    t.raw.prepare(
      `INSERT INTO project_legacy_cleanup_scopes
         (github_repository_id, organization_id, started_at)
       VALUES ('lease_legacy', 'lease_org', ?)`,
    ).run(expired);
    t.raw.prepare(
      `INSERT INTO installation_sync_leases (installation_id, owner_token, expires_at)
       VALUES ('github-installation-708', 'live-sync', ?)`,
    ).run(future);
    t.raw.prepare(
      `INSERT INTO project_release_requests
         (github_repository_id, project_id, organization_id, github_name, default_branch)
       VALUES ('lease_release', 'released-project', 'lease_org', 'lease-org/released', 'main')`,
    ).run();
    t.raw.prepare(
      `INSERT INTO project_write_leases
         (github_repository_id, project_id, owner_token, expires_at)
       VALUES ('lease_writer', 'writing-project', 'live-writer', ?)`,
    ).run(future);

    await expect(drainRepositoryAuthorityLeases(t.db, 100, now)).resolves.toBe(1);
    expect(t.raw.prepare(
      "SELECT github_repository_id FROM github_repository_reconcile_leases ORDER BY github_repository_id",
    ).all()).toEqual([
      { github_repository_id: "lease_authority" },
      { github_repository_id: "lease_future" },
      { github_repository_id: "lease_intent" },
      { github_repository_id: "lease_legacy" },
      { github_repository_id: "lease_project" },
      { github_repository_id: "lease_quarantine" },
      { github_repository_id: "lease_release" },
      { github_repository_id: "lease_snapshot" },
      { github_repository_id: "lease_sync" },
      { github_repository_id: "lease_writer" },
    ]);

    t.raw.prepare("DELETE FROM projects WHERE id = 'lease_project_id'").run();
    t.raw.prepare("DELETE FROM github_repository_authority WHERE github_repository_id = 'lease_authority'").run();
    t.raw.prepare("DELETE FROM project_reimport_quarantines WHERE github_repository_id = 'lease_quarantine'").run();
    t.raw.prepare("DELETE FROM github_sync_snapshots WHERE id = 'lease-snapshot'").run();
    t.raw.prepare("DELETE FROM project_r2_cleanup_intents WHERE github_repository_id = 'lease_intent'").run();
    t.raw.prepare("DELETE FROM project_legacy_cleanup_scopes WHERE github_repository_id = 'lease_legacy'").run();
    t.raw.prepare("DELETE FROM installation_sync_leases WHERE installation_id = 'github-installation-708'").run();
    t.raw.prepare("DELETE FROM project_release_requests WHERE github_repository_id = 'lease_release'").run();
    t.raw.prepare("DELETE FROM project_write_leases WHERE github_repository_id = 'lease_writer'").run();

    await expect(drainRepositoryAuthorityLeases(t.db, 100, now)).resolves.toBe(9);
    expect(t.raw.prepare(
      "SELECT github_repository_id FROM github_repository_reconcile_leases ORDER BY github_repository_id",
    ).all()).toEqual([{ github_repository_id: "lease_future" }]);
  });

  it("never lets an old-tenant tombstone release a transferred project", async () => {
    const t = testD1({ upTo: "0030_github_repository_lifecycle.sql" });
    open.push(t);
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_old', '123', 'old')").run();
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_new', '124', 'new')").run();
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES ('prj_new', 'org_new', ?, 'new/repo', 'main')",
    ).run(REPO);
    t.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org_old', ?, '2026-08-01T00:00:00Z', '7')",
    ).run(REPO);
    t.raw.prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES ('prj_new', '9', 'new-owner', 'admin')",
    ).run();
    applyMigration(t.raw, "0030_github_repository_lifecycle.sql");
    authorizeFinishingMigration(t);
    applyMigration(t.raw, "0031_finish_github_repository_lifecycle.sql");
    finishRollout(t);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_release_jobs WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT organization_id FROM project_legacy_cleanup_scopes WHERE github_repository_id = ?").get(REPO)).toEqual({ organization_id: "org_old" });
    const prefixes: string[] = [];
    const env = {
      DB: t.db,
      EVIDENCE: {
        list: async ({ prefix }: { prefix: string }) => {
          prefixes.push(prefix);
          return { objects: [], truncated: false };
        },
        delete: async () => undefined,
      },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;

    await expect(drainProjectReleases(env)).resolves.toEqual({ attempted: 1, released: 1, failed: 0 });
    expect(prefixes).toEqual([`org/org_old/repo/${REPO}/`]);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'prj_new'").get()).toEqual({ n: 1 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM repository_grants WHERE project_id = 'prj_new'").get()).toEqual({ n: 1 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM project_legacy_cleanup_scopes").get()).toEqual({ n: 0 });
  });
});
