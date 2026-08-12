import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import { projectsInReach } from "./dashboard-scope.js";
import { addProject, removeProject } from "./project-removal.js";
import type { Env } from "./env.js";
import { loadQueueState } from "./queue/queue-state.js";
import { installedProjectProjectionStatement } from "./github-app.js";
import { dashboardCounts } from "./dashboard-counts.js";

const open: TestD1[] = [];
const ORG = "org_1";
const REPO = "1319756073";
const PROJECT = `prj_gh_${REPO}`;
const NAME = "recallnet/playhouse";

function fixture(options: { enabled?: boolean } = {}) {
  const t = testD1();
  open.push(t);
  t.raw
    .prepare(
      "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)",
    )
    .run(ORG, "991", "recallnet", "44");
  t.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(PROJECT, ORG, REPO, NAME, "main", options.enabled ? 1 : 0);

  const deleted: string[] = [];
  const purged: string[] = [];
  const env = {
    DB: t.db,
    EVIDENCE: {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          objects: [{ key: `org/${ORG}/repo/${REPO}/proof/a` }],
          truncated: true,
          cursor: "next",
        })
        .mockResolvedValueOnce({
          objects: [{ key: `org/${ORG}/repo/${REPO}/proof/b` }],
          truncated: false,
        }),
      delete: vi.fn(async (keys: string | string[]) => deleted.push(...(Array.isArray(keys) ? keys : [keys]))),
    },
    BRANCH_QUEUE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ purge: vi.fn(async () => purged.push(name)) }),
    },
  } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
  const retired: Array<{ repositoryId: string; ref: string; prs: readonly number[] }> = [];
  const deps = {
    now: vi.fn().mockReturnValueOnce("2026-08-12T10:00:00.000Z").mockReturnValue("2026-08-12T10:00:01.000Z"),
    isCurrentOrganizationOwner: vi.fn(async () => true),
    retireStatusComments: vi.fn(async (repositoryId: string, ref: string, prs: readonly number[]) => {
      retired.push({ repositoryId, ref, prs });
    }),
  };
  return { t, env, deps, deleted, purged, retired };
}

function request(overrides: Partial<Parameters<typeof removeProject>[1]> = {}) {
  return {
    projectId: PROJECT,
    repositoryId: REPO,
    confirmation: NAME,
    actor: { organizationId: ORG, githubUserId: "7", githubOrgRole: "owner" },
    ...overrides,
  };
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  vi.restoreAllMocks();
});

describe("permanent project removal", () => {
  it("deletes repository content, retires comments, and retains only the tombstone and content-free audit", async () => {
    const { t, env, deps, deleted, purged, retired } = fixture();
    t.raw.prepare(
      "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, updated_at) VALUES (?, ?, ?, ?)",
    ).run(REPO, "refs/heads/release", 12, "now");
    t.raw.prepare(
      "INSERT INTO verification_observations (project_id, head_sha, outcome) VALUES (?, ?, ?)",
    ).run(PROJECT, "a".repeat(40), "passed");
    t.raw.prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES (?, ?, ?, ?)",
    ).run(PROJECT, "8", "andrew", "admin");
    t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_2', '992', 'other')").run();
    t.raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('other_project', 'org_2', '555', 'other/kept', 0)",
    ).run();
    t.raw.prepare(
      "INSERT INTO verification_observations (project_id, head_sha, outcome) VALUES ('other_project', ?, 'passed')",
    ).run("c".repeat(40));
    t.raw.prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login) VALUES ('principal_7', ?, '7', 'carson')",
    ).run(ORG);
    t.raw.prepare(
      "INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label) VALUES ('key_7', '7', 'ssh-ed25519', 'public', 'fingerprint', 'laptop')",
    ).run();
    t.raw.prepare(
      "INSERT INTO stripe_state (organization_id, stripe_customer_id, plan, status) VALUES (?, 'cus_1', 'pro', 'active')",
    ).run(ORG);

    expect((await projectsInReach(t.db, { organizationId: ORG, githubUserId: "7" })).map((row) => row.github_name)).toEqual([NAME]);

    const result = await removeProject(env, request(), deps);

    expect(result).toEqual({ ok: true, repositoryId: REPO, alreadyRemoved: false });
    expect(retired).toEqual([{ repositoryId: REPO, ref: "refs/heads/release", prs: [12] }]);
    expect(deleted).toEqual([
      `org/${ORG}/repo/${REPO}/proof/a`,
      `org/${ORG}/repo/${REPO}/proof/b`,
    ]);
    expect(purged).toHaveLength(2);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM verification_observations WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM repository_grants WHERE project_id = ?").get(PROJECT)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT github_name FROM projects WHERE id = 'other_project'").get()).toEqual({ github_name: "other/kept" });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM verification_observations WHERE project_id = 'other_project'").get()).toEqual({ n: 1 });
    expect(t.raw.prepare("SELECT github_login FROM principals WHERE id = 'principal_7'").get()).toEqual({ github_login: "carson" });
    expect(t.raw.prepare("SELECT device_label FROM device_keys WHERE key_id = 'key_7'").get()).toEqual({ device_label: "laptop" });
    expect(t.raw.prepare("SELECT stripe_customer_id FROM stripe_state WHERE organization_id = ?").get(ORG)).toEqual({ stripe_customer_id: "cus_1" });
    expect(t.raw.prepare("SELECT * FROM removed_projects").all()).toEqual([
      {
        organization_id: ORG,
        github_repository_id: REPO,
        deleted_at: "2026-08-12T10:00:00.000Z",
        deleted_by_github_user_id: "7",
      },
    ]);
    expect(t.raw.prepare("SELECT * FROM project_deletion_audits").all()).toEqual([
      {
        organization_id: ORG,
        github_repository_id: REPO,
        actor_github_user_id: "7",
        requested_at: "2026-08-12T10:00:00.000Z",
        completed_at: "2026-08-12T10:00:01.000Z",
        outcome: "completed",
      },
    ]);
    expect(
      t.raw
        .prepare(
          "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, updated_at) VALUES (?, 'refs/heads/main', 99, 'later')",
        )
        .run(REPO).changes,
    ).toBe(0);
    expect(
      t.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'removed_project_blocks_%'").get(),
    ).toEqual({ n: 12 });
  });

  it("requires the projected and current GitHub owner, exact name, and a disabled project", async () => {
    const projected = fixture();
    projected.t.raw.prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES (?, '7', 'carson', 'admin')",
    ).run(PROJECT);
    expect(await removeProject(projected.env, request({ actor: { organizationId: ORG, githubUserId: "7", githubOrgRole: "member" } }), projected.deps))
      .toMatchObject({ ok: false, code: "ORGANIZATION_OWNER_REQUIRED" });

    const outside = fixture();
    expect(await removeProject(outside.env, request({ actor: { organizationId: ORG, githubUserId: "7", githubOrgRole: "outside" } }), outside.deps))
      .toMatchObject({ ok: false, code: "ORGANIZATION_OWNER_REQUIRED" });

    const otherOrganization = fixture();
    otherOrganization.t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_2', '992', 'other')").run();
    expect(await removeProject(otherOrganization.env, request({ actor: { organizationId: "org_2", githubUserId: "7", githubOrgRole: "owner" } }), otherOrganization.deps))
      .toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });

    const fresh = fixture();
    fresh.deps.isCurrentOrganizationOwner.mockResolvedValue(false);
    expect(await removeProject(fresh.env, request(), fresh.deps)).toMatchObject({ ok: false, code: "ORGANIZATION_OWNER_REQUIRED" });

    const confirmation = fixture();
    expect(await removeProject(confirmation.env, request({ confirmation: "recallnet/other" }), confirmation.deps))
      .toMatchObject({ ok: false, code: "CONFIRMATION_MISMATCH" });

    const enabled = fixture({ enabled: true });
    expect(await removeProject(enabled.env, request(), enabled.deps)).toMatchObject({ ok: false, code: "DISABLE_PROJECT_FIRST" });
  });

  it("refuses nonterminal queue work with an exact recovery command", async () => {
    const { t, env, deps } = fixture();
    const queue = await loadQueueState(t.db, REPO, "refs/heads/main");
    queue.store.append({
      idempotencyKey: "request-14",
      at: "2026-08-12T00:00:00.000Z",
      type: "QueueRequested",
      entryId: "entry_1",
      pullRequestNumber: 14,
      sponsorPrincipalId: "p",
      sponsorGithubUserId: "7",
      headSha: "a".repeat(40),
    });
    expect(await queue.save()).toBe("saved");

    const result = await removeProject(env, request(), deps);
    expect(result).toMatchObject({ ok: false, code: "QUEUE_NOT_DRAINED" });
    if (!result.ok) expect(result.detail).toContain("drain or cancel it");
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM removed_projects").get()).toEqual({ n: 0 });
  });

  it("refuses an unresolved merge write and names queue doctor", async () => {
    const { t, env, deps } = fixture();
    const queue = await loadQueueState(t.db, REPO, "refs/heads/main");
    queue.store.beginMergeOperation({
      operationId: "op_1",
      attemptId: "att_1",
      attemptRevision: 1,
      expectedBaseSha: "b".repeat(40),
      expectedHeadSha: "h".repeat(40),
      expectedTreeOid: "t".repeat(40),
      pullRequestNumber: 14,
      at: "2026-08-12T00:00:00.000Z",
    });
    expect(await queue.save()).toBe("saved");

    const result = await removeProject(env, request(), deps);
    expect(result).toMatchObject({ ok: false, code: "QUEUE_NOT_DRAINED" });
    if (!result.ok) {
      expect(result.detail).toContain("merge operation op_1 is unresolved");
      expect(result.detail).toContain("thwip queue doctor --repo recallnet/playhouse");
    }
  });

  it("hides a marked partial removal, blocks recreation, and completes safely on retry", async () => {
    const { t, env, deps } = fixture();
    const failed = { ...deps, afterMarker: vi.fn(async () => { throw new Error("injected"); }) };
    await expect(removeProject(env, request(), failed)).rejects.toThrow("injected");

    expect(await projectsInReach(t.db, { organizationId: ORG, githubUserId: "7" })).toEqual([]);
    expect(await dashboardCounts(t.db, { organizationId: ORG, githubUserId: "7" })).toMatchObject({
      projects: 0,
      enabledProjects: 0,
    });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(PROJECT)).toEqual({ n: 1 });

    const retry = await removeProject(env, request(), deps);
    expect(retry).toEqual({ ok: true, repositoryId: REPO, alreadyRemoved: false });
    expect(await removeProject(env, request({ confirmation: "" }), deps)).toEqual({
      ok: true,
      repositoryId: REPO,
      alreadyRemoved: true,
    });
  });

  it("explicitly re-adds an installed repository as fresh and disabled", async () => {
    const { t, env, deps } = fixture();
    await removeProject(env, request(), deps);

    const result = await addProject(
      env,
      { fullName: NAME, actor: request().actor },
      {
        isCurrentOrganizationOwner: async () => true,
        installedRepository: async () => ({ id: REPO, fullName: NAME, defaultBranch: "main", ownerId: "991" }),
      },
    );

    expect(result).toEqual({ ok: true, projectId: PROJECT, repositoryId: REPO, name: NAME });
    expect(t.raw.prepare("SELECT enabled, active_policy_digest FROM projects WHERE id = ?").get(PROJECT)).toEqual({ enabled: 0, active_policy_digest: null });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM removed_projects").get()).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT outcome FROM project_deletion_audits").all()).toEqual([{ outcome: "completed" }]);
  });

  it("does not let installation sync recreate a removed project", async () => {
    const { t, env, deps } = fixture();
    await removeProject(env, request(), deps);

    await installedProjectProjectionStatement(t.db as unknown as D1Database, ORG, {
      id: Number(REPO),
      full_name: NAME,
      default_branch: "main",
    }).run();

    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 0 });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM removed_projects WHERE github_repository_id = ?").get(REPO)).toEqual({ n: 1 });
  });
});
