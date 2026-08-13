import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../test/d1.js";
import type { Env } from "./env.js";
import {
  deleteInstallation,
  drainGithubSyncSnapshots,
  enqueueAppInstallationReconciliation,
  enqueueDueProjectReimportReconciliation,
  installationToken,
  listInstallationsWithToken,
  syncInstallation,
  syncOrDeleteInstallation,
} from "./github-app.js";
import { GithubApiError, GithubRateLimitError } from "./github-error.js";
import { drainProjectReleases, pendingProjectReimports } from "./project-lifecycle.js";
import { repositoryAccess } from "./queue/repository-access.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("authoritative GitHub App lifecycle reads", () => {
  it("mints a repository-scoped token for every repository operation", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    let body: unknown = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      body = JSON.parse(String(init?.body));
      return response({ token: "scoped-token" });
    });
    await expect(installationToken({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    } as Env, "42", undefined, "1319756073")).resolves.toBe("scoped-token");
    expect(body).toEqual({ repository_ids: [1319756073] });
  });

  it("paginates every App installation", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { id: index + 1, login: `org-${index + 1}`, type: "Organization" },
      repository_selection: "selected",
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response([{ ...first[0], id: 101 }]))
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response([{ ...first[0], id: 101 }]));

    const result = await listInstallationsWithToken("app-jwt");

    expect(result).toHaveLength(101);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/app/installations?per_page=100&page=1",
      "https://api.github.com/app/installations?per_page=100&page=2",
      "https://api.github.com/app/installations?per_page=100&page=1",
      "https://api.github.com/app/installations?per_page=100&page=2",
    ]);
  });

  it("honors a short Retry-After response but stops after the bounded retry count", async () => {
    const transient = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    await expect(listInstallationsWithToken("app-jwt")).resolves.toEqual([]);
    expect(transient).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
    const persistent = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("still limited", { status: 429, headers: { "retry-after": "0" } }),
    );
    await expect(listInstallationsWithToken("app-jwt")).rejects.toMatchObject({ status: 429 });
    expect(persistent).toHaveBeenCalledTimes(3);
  });

  it("carries GitHub's primary rate-limit reset onto a delayed queue retry", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 900;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary rate limit exhausted", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        },
      }),
    );

    const error = await listInstallationsWithToken("app-jwt").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect(error).toMatchObject({ status: 403 });
    expect((error as GithubRateLimitError).retryAfterSeconds).toBeGreaterThanOrEqual(900);
    expect((error as GithubRateLimitError).retryAfterSeconds).toBeLessThanOrEqual(902);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated full pages and identity churn instead of accepting an incomplete authority snapshot", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { id: index + 1, login: `org-${index + 1}`, type: "Organization" },
      repository_selection: "selected",
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(full));
    await expect(listInstallationsWithToken("app-jwt")).rejects.toThrow("made no progress");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([{ ...full[0], id: 1 }]))
      .mockResolvedValueOnce(response([{ ...full[0], id: 2 }]));
    await expect(listInstallationsWithToken("app-jwt")).rejects.toThrow("changed identities");
  });

  it("fans every current and locally known installation into isolated queue work", async () => {
    const t = testD1();
    try {
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_local', '7', 'local', '90071992547409931235')",
      ).run();
      const batches: Array<Array<{ installationId: string }>> = [];
      const result = await enqueueAppInstallationReconciliation(
        { DB: t.db } as unknown as Env,
        {
          list: async () => [
            ...Array.from({ length: 205 }, (_, index) => ({ id: index + 1 })),
            { id: "90071992547409931234" },
            { id: "90071992547409931235" },
          ],
          enqueueBatch: async (messages) => { batches.push([...messages]); },
        },
      );

      expect(result).toEqual([
        ...Array.from({ length: 205 }, (_, index) => String(index + 1)),
        "90071992547409931234",
        "90071992547409931235",
      ]);
      expect(batches.flat().map((message) => message.installationId)).toEqual(result);
      expect(batches.map((batch) => batch.length)).toEqual([100, 100, 7]);
      expect(batches.flat()).toEqual(result.map((installationId) => expect.objectContaining({
        event: "policy_reconcile",
        installationId,
        syncInstallation: true,
      })));
    } finally {
      t.close();
    }
  });

  it("lets independent installations converge while one installation sync is slow", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      let unblockSlow!: () => void;
      let markBlocked!: () => void;
      const slowGate = new Promise<void>((resolve) => { unblockSlow = resolve; });
      const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
      let slowWaited = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        const installation = url.pathname.match(/^\/app\/installations\/(81|82)$/)?.[1];
        if (installation !== undefined) {
          return response({
            account: { id: Number(installation), login: `org-${installation}`, type: "Organization" },
            repository_selection: "selected",
          });
        }
        const tokenInstallation = url.pathname.match(/^\/app\/installations\/(81|82)\/access_tokens$/)?.[1];
        if (tokenInstallation !== undefined && init?.method === "POST") {
          return response({ token: `token-${tokenInstallation}` });
        }
        if (url.pathname === "/installation/repositories") {
          if (authorization === "Bearer token-81" && !slowWaited) {
            slowWaited = true;
            markBlocked();
            await slowGate;
          }
          return response({ total_count: 0, repositories: [] });
        }
        if (/^\/orgs\/org-(81|82)\/(members|outside_collaborators|teams)/.test(url.pathname)) return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      });

      const slow = syncInstallation(env, "81");
      await blocked;
      await expect(syncInstallation(env, "82")).resolves.toMatchObject({ repos: 0 });
      unblockSlow();
      await expect(slow).resolves.toMatchObject({ repos: 0 });
      expect(t.raw.prepare(
        "SELECT github_org_id, status FROM organizations WHERE github_org_id IN ('81', '82') ORDER BY github_org_id",
      ).all()).toEqual([
        { github_org_id: "81", status: "active" },
        { github_org_id: "82", status: "active" },
      ]);
    } finally {
      t.close();
    }
  });

  it("does not publish a stale snapshot after another sync takes ownership", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_86', '86', 'ownership', '86', 'active')",
      ).run();
      t.raw.prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role) VALUES ('sentinel', 'org_gh_86', '7', 'sentinel', 'owner')",
      ).run();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/86") return response({ account: { id: 86, login: "ownership", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/86/access_tokens" && init?.method === "POST") return response({ token: "installation-token" });
        if (url.pathname === "/installation/repositories") return response({ total_count: 0, repositories: [] });
        if (path.startsWith("/orgs/ownership/members?role=") || url.pathname === "/orgs/ownership/outside_collaborators" || url.pathname === "/orgs/ownership/teams") return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "86", {
        beforePublicationBatch: async () => {
          t.raw.prepare(
            "UPDATE installation_sync_leases SET owner_token = 'new-owner', expires_at = '2099-01-01T00:00:00.000Z' WHERE installation_id = 'github-installation-86'",
          ).run();
          t.raw.prepare("UPDATE organizations SET status = 'active' WHERE id = 'org_gh_86'").run();
        },
      })).rejects.toThrow("snapshot ownership was lost");
      expect(t.raw.prepare("SELECT github_org_role FROM principals WHERE id = 'sentinel'").get()).toEqual({
        github_org_role: "owner",
      });
      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_86'").get()).toEqual({ status: "active" });
      expect(t.raw.prepare("SELECT COUNT(*) AS n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("turns only the exact authoritative installation 404 into idempotent uninstall cleanup", async () => {
    const remove = vi.fn(async () => undefined);
    const missing = new GithubApiError("/app/installations/42", 404, "not found");
    const env = {} as Env;

    await expect(
      syncOrDeleteInstallation(env, "42", {
        sync: async () => Promise.reject(missing),
        remove,
      }),
    ).resolves.toBe("deleted");
    await expect(
      syncOrDeleteInstallation(env, "42", {
        sync: async () => Promise.reject(missing),
        remove,
      }),
    ).resolves.toBe("deleted");
    expect(remove).toHaveBeenCalledTimes(2);

    for (const error of [
      new GithubApiError("/app/installations/42", 403, "forbidden"),
      new GithubApiError("/installation/repositories", 404, "not found"),
    ]) {
      await expect(
        syncOrDeleteInstallation(env, "42", {
          sync: async () => Promise.reject(error),
          remove,
        }),
      ).rejects.toBe(error);
    }
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("removes crash-orphaned nullable staging rows when an installation is uninstalled", async () => {
    const t = testD1();
    try {
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_gone', '701', 'gone', '701')",
      ).run();
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_kept', '702', 'kept', '702')",
      ).run();
      for (const [snapshot, org, installation, repository] of [
        ["orphan-gone", "org_gone", "701", "900"],
        ["orphan-kept", "org_kept", "702", "901"],
      ] as const) {
        t.raw.prepare(
          "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, owner_token) VALUES (?, ?, ?, 'dead-owner')",
        ).run(snapshot, org, installation);
        t.raw.prepare(
          "INSERT INTO github_sync_grants (snapshot_id, github_repository_id, project_id, github_user_id, github_login, permission) VALUES (?, ?, NULL, '77', 'stale', 'admin')",
        ).run(snapshot, repository);
        t.raw.prepare(
          "INSERT INTO github_sync_team_repos (snapshot_id, team_id, github_repository_id, project_id, permission) VALUES (?, 'team', ?, NULL, 'admin')",
        ).run(snapshot, repository);
      }
      t.raw.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, selected)
         VALUES ('900', 'org_gone', '701', 'orphan-gone', 1),
                ('901', 'org_kept', '702', 'orphan-kept', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_reconcile_leases
           (github_repository_id, installation_id, owner_token, epoch, expires_at)
         VALUES ('900', '701', 'gone-owner', 2, '2000-01-01T00:00:00.000Z'),
                ('901', '702', 'kept-owner', 3, '2999-01-01T00:00:00.000Z')`,
      ).run();

      await deleteInstallation({ DB: t.db } as unknown as Env, "701");

      expect(t.raw.prepare("SELECT id FROM github_sync_snapshots ORDER BY id").all()).toEqual([{ id: "orphan-kept" }]);
      expect(t.raw.prepare("SELECT snapshot_id FROM github_sync_grants ORDER BY snapshot_id").all()).toEqual([
        { snapshot_id: "orphan-kept" },
      ]);
      expect(t.raw.prepare("SELECT snapshot_id FROM github_sync_team_repos ORDER BY snapshot_id").all()).toEqual([
        { snapshot_id: "orphan-kept" },
      ]);
      expect(t.raw.prepare("SELECT installation_id, status FROM organizations WHERE id = 'org_gone'").get()).toEqual({
        installation_id: null,
        status: "disconnected",
      });
      expect(t.raw.prepare(
        "SELECT github_repository_id, installation_id FROM github_repository_authority ORDER BY github_repository_id",
      ).all()).toEqual([{ github_repository_id: "901", installation_id: "702" }]);
      expect(t.raw.prepare(
        "SELECT github_repository_id, installation_id FROM github_repository_reconcile_leases ORDER BY github_repository_id",
      ).all()).toEqual([{ github_repository_id: "901", installation_id: "702" }]);
    } finally {
      t.close();
    }
  });

  it("retires a missed old installation after a same-organization empty reinstall", async () => {
    const t = testD1();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      const removedAt = new Date("2030-01-01T00:00:00.000Z");
      vi.setSystemTime(removedAt);
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
        EVIDENCE: {
          list: async () => ({ objects: [], truncated: false }),
          delete: async () => {},
          head: async () => null,
        },
        BRANCH_QUEUE: {
          idFromName: (name: string) => name,
          get: () => ({ purge: async () => {} }),
        },
      } as unknown as Env;
      t.raw.prepare(
        `INSERT INTO organizations (id, github_org_id, github_login, installation_id, status)
         VALUES ('org_reinstalled', '777', 'same-owner', '701', 'active')`,
      ).run();
      t.raw.prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES ('old-project', 'org_reinstalled', '9901', 'same-owner/removed', 'main', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_sync_snapshots
           (id, organization_id, installation_id, owner_token, publication_ready)
         VALUES ('old-installation-snapshot', 'org_reinstalled', '701', 'old-owner', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         VALUES ('9901', 'org_reinstalled', '701', 'old-installation-snapshot', 1, 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_reconcile_leases
           (github_repository_id, installation_id, owner_token, epoch, expires_at)
         VALUES ('9901', '701', 'old-owner', 1, '2000-01-01T00:00:00.000Z')`,
      ).run();

      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/702") {
          return response({
            account: { id: 777, login: "same-owner", type: "Organization" },
            repository_selection: "selected",
          });
        }
        if (url.pathname === "/app/installations/702/access_tokens" && init?.method === "POST") {
          return response({ token: "new-installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({ total_count: 0, repositories: [] });
        }
        if (path.startsWith("/orgs/same-owner/members?role=") ||
            url.pathname === "/orgs/same-owner/outside_collaborators" ||
            url.pathname === "/orgs/same-owner/teams") {
          return response([]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "702")).resolves.toMatchObject({ continued: 0, repos: 0 });
      expect(t.raw.prepare(
        "SELECT installation_id, status FROM organizations WHERE id = 'org_reinstalled'",
      ).get()).toEqual({ installation_id: "702", status: "active" });
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = '9901'").get()).toBeUndefined();
      expect(t.raw.prepare(
        "SELECT installation_id FROM github_repository_authority WHERE github_repository_id = '9901'",
      ).get()).toBeUndefined();
      expect(t.raw.prepare(
        "SELECT id FROM github_sync_snapshots WHERE installation_id = '701'",
      ).get()).toEqual({ id: "old-installation-snapshot" });

      // Seed live I2 state after its authoritative sync. A delayed I1 delete
      // must remove only I1 residue and cannot disconnect or mutate I2.
      t.raw.prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES ('current-project', 'org_reinstalled', '9902', 'same-owner/current', 'main', 0)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         VALUES ('9902', 'org_reinstalled', '702', 'current-i2', 7, 1)`,
      ).run();
      // Model an exact I1 authority delivery that lands after I2 publication.
      // Delayed uninstall cleanup must not need the organization's now-I2
      // installation pointer to find and remove it.
      t.raw.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         VALUES ('9903', 'org_reinstalled', '701', 'old-installation-snapshot', 2, 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_reconcile_leases
           (github_repository_id, installation_id, owner_token, epoch, expires_at)
         VALUES ('9903', '701', 'late-old-owner', 2, '2000-01-01T00:00:00.000Z')`,
      ).run();
      await expect(deleteInstallation(env, "701")).resolves.toBeUndefined();
      expect(t.raw.prepare(
        "SELECT installation_id, status FROM organizations WHERE id = 'org_reinstalled'",
      ).get()).toEqual({ installation_id: "702", status: "active" });
      expect(t.raw.prepare(
        "SELECT id, enabled FROM projects WHERE github_repository_id = '9902'",
      ).get()).toEqual({ id: "current-project", enabled: 0 });
      expect(t.raw.prepare(
        "SELECT installation_id, selected FROM github_repository_authority WHERE github_repository_id = '9902'",
      ).get()).toEqual({ installation_id: "702", selected: 1 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_sync_snapshots WHERE installation_id = '701'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_authority WHERE installation_id = '701'",
      ).get()).toEqual({ count: 0 });

      const boundary = new Date("2030-01-01T01:00:00.000Z");
      vi.setSystemTime(boundary);
      await expect(drainProjectReleases(env, 10, { now: () => boundary }))
        .resolves.toEqual({ attempted: 0, released: 0, failed: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM project_reimport_quarantines WHERE github_repository_id = '9901'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_authority WHERE github_repository_id = '9901'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_reconcile_leases WHERE github_repository_id = '9901'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_reconcile_leases WHERE github_repository_id = '9903'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = '9902'").get())
        .toEqual({ id: "current-project" });
    } finally {
      t.close();
    }
  });

  it("cannot release a new installation that takes over after old uninstall lookup", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
        EVIDENCE: {
          list: async () => ({ objects: [], truncated: false }),
          delete: async () => {},
          head: async () => null,
        },
        BRANCH_QUEUE: {
          idFromName: (name: string) => name,
          get: () => ({ purge: async () => {} }),
        },
      } as unknown as Env;
      t.raw.prepare(
        `INSERT INTO organizations (id, github_org_id, github_login, installation_id, status)
         VALUES ('org_race', '777', 'same-owner', '701', 'active')`,
      ).run();
      t.raw.prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES ('old-project', 'org_race', '9901', 'same-owner/old', 'main', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_sync_snapshots
           (id, organization_id, installation_id, owner_token, publication_ready)
         VALUES ('old-snapshot', 'org_race', '701', 'old-owner', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         VALUES ('9901', 'org_race', '701', 'old-snapshot', 1, 1)`,
      ).run();

      let oldRead!: () => void;
      let resumeOld!: () => void;
      const read = new Promise<void>((resolve) => { oldRead = resolve; });
      const resume = new Promise<void>((resolve) => { resumeOld = resolve; });
      const deleting = deleteInstallation(env, "701", {
        afterOrganizationRead: async () => {
          oldRead();
          await resume;
        },
      });
      await read;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/702") {
          return response({
            account: { id: 777, login: "same-owner", type: "Organization" },
            repository_selection: "selected",
          });
        }
        if (url.pathname === "/app/installations/702/access_tokens" && init?.method === "POST") {
          return response({ token: "new-installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({
            total_count: 1,
            repositories: [{ id: 9902, full_name: "same-owner/current", default_branch: "main" }],
          });
        }
        if (path.startsWith("/orgs/same-owner/members?role=") ||
            url.pathname === "/orgs/same-owner/outside_collaborators" ||
            url.pathname === "/orgs/same-owner/teams" ||
            url.pathname === "/repos/same-owner/current/collaborators") {
          return response([]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });
      await expect(syncInstallation(env, "702")).resolves.toMatchObject({ continued: 0, repos: 1 });
      const currentBeforeResume = t.raw.prepare(
        `SELECT project.id, project.enabled, organization.installation_id
           FROM projects project JOIN organizations organization ON organization.id = project.organization_id
          WHERE project.github_repository_id = '9902'`,
      ).get();
      expect(currentBeforeResume).toEqual({ id: expect.any(String), enabled: 0, installation_id: "702" });

      resumeOld();
      await expect(deleting).resolves.toBeUndefined();
      expect(t.raw.prepare(
        `SELECT project.id, project.enabled, organization.installation_id
           FROM projects project JOIN organizations organization ON organization.id = project.organization_id
          WHERE project.github_repository_id = '9902'`,
      ).get()).toEqual(currentBeforeResume);
      expect(t.raw.prepare(
        "SELECT installation_id, selected FROM github_repository_authority WHERE github_repository_id = '9902'",
      ).get()).toEqual({ installation_id: "702", selected: 1 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_authority WHERE installation_id = '701'",
      ).get()).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_sync_snapshots WHERE installation_id = '701'",
      ).get()).toEqual({ count: 0 });
    } finally {
      t.close();
    }
  });

  it("keeps a new same-organization installation quarantined when old uninstall fences first", async () => {
    const t = testD1();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      const removedAt = new Date("2030-01-01T00:00:00.000Z");
      vi.setSystemTime(removedAt);
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
        EVIDENCE: {
          list: async () => ({ objects: [], truncated: false }),
          delete: async () => {},
          head: async () => null,
        },
        BRANCH_QUEUE: {
          idFromName: (name: string) => name,
          get: () => ({ purge: async () => {} }),
        },
      } as unknown as Env;
      t.raw.prepare(
        `INSERT INTO organizations (id, github_org_id, github_login, installation_id, status)
         VALUES ('org_fence_first', '777', 'same-owner', '701', 'active')`,
      ).run();
      t.raw.prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES ('old-project', 'org_fence_first', '9901', 'same-owner/reselected', 'main', 1)`,
      ).run();
      await expect(deleteInstallation(env, "701")).resolves.toBeUndefined();
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = '9901'").get()).toBeUndefined();
      const quarantine = t.raw.prepare(
        "SELECT reimport_not_before AS notBefore FROM project_reimport_quarantines WHERE github_repository_id = '9901'",
      ).get() as { notBefore: string };
      expect(quarantine.notBefore).toBe("2030-01-01T01:00:00.000Z");

      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/702") {
          return response({
            account: { id: 777, login: "same-owner", type: "Organization" },
            repository_selection: "selected",
          });
        }
        if (url.pathname === "/app/installations/702/access_tokens" && init?.method === "POST") {
          return response({ token: "new-installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({
            total_count: 1,
            repositories: [{ id: 9901, full_name: "same-owner/reselected", default_branch: "main" }],
          });
        }
        if (path.startsWith("/orgs/same-owner/members?role=") ||
            url.pathname === "/orgs/same-owner/outside_collaborators" ||
            url.pathname === "/orgs/same-owner/teams" ||
            url.pathname === "/repos/same-owner/reselected/collaborators") {
          return response([]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      const early = new Date("2030-01-01T00:05:00.000Z");
      vi.setSystemTime(early);
      const delayed: Array<{ installationId: string; notBefore: string | undefined }> = [];
      await expect(syncInstallation(env, "702", {
        now: () => early,
        enqueueContinuation: async (installationId, schedule) => {
          delayed.push({ installationId, notBefore: schedule?.notBefore });
        },
      })).resolves.toMatchObject({ continued: 1 });
      expect(delayed).toEqual([{ installationId: "702", notBefore: quarantine.notBefore }]);
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = '9901'").get()).toBeUndefined();

      const boundary = new Date(quarantine.notBefore);
      vi.setSystemTime(boundary);
      await expect(syncInstallation(env, "702", {
        now: () => boundary,
        enqueueContinuation: async () => {},
      })).resolves.toMatchObject({ continued: 0 });
      expect(t.raw.prepare(
        `SELECT project.enabled, organization.installation_id
           FROM projects project JOIN organizations organization ON organization.id = project.organization_id
          WHERE project.github_repository_id = '9901'`,
      ).get()).toEqual({ enabled: 0, installation_id: "702" });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM project_reimport_quarantines WHERE github_repository_id = '9901'",
      ).get()).toEqual({ count: 0 });
    } finally {
      t.close();
    }
  });

  it("globally drains orphan snapshots in bounded pages without touching a live owner", async () => {
    const t = testD1();
    try {
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_snapshots', '703', 'snapshots', '703')",
      ).run();
      for (const id of ["old-a", "old-b", "old-c", "live"]) {
        t.raw.prepare(
          "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, owner_token, created_at) VALUES (?, 'org_snapshots', '703', ?, ?)",
        ).run(id, id === "live" ? "live-owner" : "dead-owner", id === "live" ? "2099-01-01T00:00:00.000Z" : `2000-01-0${id === "old-a" ? 1 : id === "old-b" ? 2 : 3}T00:00:00.000Z`);
        t.raw.prepare(
          "INSERT INTO github_sync_grants (snapshot_id, github_repository_id, project_id, github_user_id, github_login, permission) VALUES (?, '901', NULL, ?, 'stale', 'read')",
        ).run(id, id);
      }
      t.raw.prepare(
        "INSERT INTO installation_sync_leases (installation_id, owner_token, expires_at) VALUES ('github-installation-703', 'live-owner', '2099-01-01T00:00:00.000Z')",
      ).run();

      await expect(drainGithubSyncSnapshots({ DB: t.db } as unknown as Env, 2)).resolves.toBe(2);
      expect(t.raw.prepare("SELECT id FROM github_sync_snapshots ORDER BY id").all()).toEqual([
        { id: "live" },
        { id: "old-c" },
      ]);
      await expect(drainGithubSyncSnapshots({ DB: t.db } as unknown as Env, 2)).resolves.toBe(1);
      expect(t.raw.prepare("SELECT id FROM github_sync_snapshots").all()).toEqual([{ id: "live" }]);
      expect(t.raw.prepare("SELECT snapshot_id FROM github_sync_grants").all()).toEqual([{ snapshot_id: "live" }]);
    } finally {
      t.close();
    }
  });

  it("preserves queued and rate-limited continuations but abandons one that stayed unclaimed for a day", async () => {
    const t = testD1();
    try {
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_continuations', '704', 'continuations', '704')",
      ).run();
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      const abandoned = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
      for (const [id, notBefore] of [
        ["queued", new Date().toISOString()],
        ["rate-limited", future],
        ["abandoned", abandoned],
      ] as const) {
        t.raw.prepare(
          `INSERT INTO github_sync_snapshots
             (id, organization_id, installation_id, owner_token, continuation_pending, continuation_not_before)
           VALUES (?, 'org_continuations', '704', 'released-owner', 1, ?)`,
        ).run(id, notBefore);
      }

      await expect(drainGithubSyncSnapshots({ DB: t.db } as unknown as Env, 10)).resolves.toBe(1);
      expect(t.raw.prepare(
        "SELECT id, continuation_pending FROM github_sync_snapshots ORDER BY id",
      ).all()).toEqual([
        { id: "queued", continuation_pending: 1 },
        { id: "rate-limited", continuation_pending: 1 },
      ]);
    } finally {
      t.close();
    }
  });

  it("records a delayed rate-limit continuation before releasing the installation lease", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        if (url.pathname === "/app/installations/705") {
          return response({ account: { id: 705, login: "delayed", type: "Organization" }, repository_selection: "selected" });
        }
        if (url.pathname === "/app/installations/705/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return new Response("slow down", { status: 429, headers: { "retry-after": "900" } });
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      });

      await expect(syncInstallation(env, "705", {
        postSyncWork: { reconcilePolicies: false, reconcileProofChecks: true },
        enqueueContinuation: async () => {},
      }))
        .rejects.toBeInstanceOf(GithubRateLimitError);
      const snapshot = t.raw.prepare(
        `SELECT continuation_pending, continuation_not_before AS notBefore,
                post_sync_policy_reconcile AS policies,
                post_sync_proof_reconcile AS proofs
           FROM github_sync_snapshots WHERE installation_id = '705'`,
      ).get() as { continuation_pending: number; notBefore: string; policies: number; proofs: number };
      expect(snapshot.continuation_pending).toBe(1);
      expect(snapshot).toMatchObject({ policies: 0, proofs: 1 });
      expect(Date.parse(snapshot.notBefore)).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS n FROM installation_sync_leases WHERE installation_id = 'github-installation-705'",
      ).get()).toEqual({ n: 0 });
      await expect(drainGithubSyncSnapshots(env, 10)).resolves.toBe(0);
    } finally {
      t.close();
    }
  });

  it("atomically removes stale membership and teams while retaining current outside access", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      let batchCalls = 0;
      let failBatchAt: number | null = null;
      const env = {
        DB: {
          ...t.db,
          batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
            if (statements.length > 100) throw new Error("D1 batch exceeded 100 statements");
            batchCalls += 1;
            if (batchCalls === failBatchAt) throw new Error("injected staged batch failure");
            return t.db.batch!(statements as never);
          },
        },
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      let generation: "first" | "second" | "failed" | "rate-limited" = "first";
      let failedAdminReads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/42") {
          return response({ account: { id: 7, login: "acme", type: "Organization" }, repository_selection: "selected" });
        }
        if (url.pathname === "/app/installations/42/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({
            total_count: 1,
            repositories: [{ id: 99, full_name: "acme/repo", default_branch: "main" }],
          });
        }
        if (path.startsWith("/orgs/acme/members?role=admin")) {
          if (generation === "rate-limited") return new Response("rate limited", { status: 429 });
          if (generation === "first") return response([{ id: 10, login: "owner", avatar_url: "owner.png" }]);
          if (generation === "failed") {
            failedAdminReads += 1;
            const id = failedAdminReads === 1 ? 30 : 31;
            return response([{ id, login: `churn-${id}`, avatar_url: "churn.png" }]);
          }
          return response([]);
        }
        if (path.startsWith("/orgs/acme/members?role=member")) return response([]);
        if (url.pathname === "/orgs/acme/outside_collaborators") {
          return response([{ id: 20, login: "outside", avatar_url: "outside.png" }]);
        }
        if (url.pathname === "/orgs/acme/teams") {
          return response(generation === "first" ? [{ id: 30, slug: "engineering", name: "Engineering" }] : []);
        }
        if (url.pathname === "/orgs/acme/teams/engineering/members") {
          return response([{ id: 10, login: "owner" }]);
        }
        if (url.pathname === "/orgs/acme/teams/engineering/repos") {
          return response([{ id: 99, role_name: "admin", permissions: { admin: true } }]);
        }
        if (path.startsWith("/repos/acme/repo/collaborators?affiliation=all")) {
          return response(
            generation === "first"
              ? [
                  { id: 10, login: "owner", role_name: "admin", permissions: { admin: true } },
                  { id: 20, login: "outside", role_name: "read", permissions: { pull: true } },
                ]
              : [{ id: 20, login: "outside", role_name: "read", permissions: { pull: true } }],
          );
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await syncInstallation(env, "42");
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_teams WHERE organization_id = 'org_gh_7'").get()).toEqual({ n: 1 });

      generation = "second";
      await syncInstallation(env, "42");

      expect(t.raw.prepare("SELECT github_org_role FROM principals WHERE github_user_id = '10'").get()).toEqual({
        github_org_role: "removed",
      });
      expect(t.raw.prepare("SELECT github_org_role FROM principals WHERE github_user_id = '20'").get()).toEqual({
        github_org_role: "outside",
      });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_teams WHERE organization_id = 'org_gh_7'").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM team_members WHERE organization_id = 'org_gh_7'").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM team_repos WHERE organization_id = 'org_gh_7'").get()).toEqual({ n: 0 });
      expect(
        await repositoryAccess(t.db, "99", {
          principalId: "prn_gh_10_org_7",
          githubUserId: "10",
          isAdmin: true,
        }),
      ).toBe("none");
      expect(
        await repositoryAccess(t.db, "99", {
          principalId: "prn_gh_20_org_7",
          githubUserId: "20",
        }),
      ).toBe("read");
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });

      generation = "failed";
      await expect(syncInstallation(env, "42")).rejects.toThrow("changed installation authority before publication");
      expect(t.raw.prepare("SELECT github_org_role FROM principals WHERE github_user_id = '10'").get()).toEqual({
        github_org_role: "removed",
      });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_teams WHERE organization_id = 'org_gh_7'").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });

      generation = "rate-limited";
      await expect(syncInstallation(env, "42")).rejects.toMatchObject({ status: 429 });
      expect(t.raw.prepare("SELECT github_org_role FROM principals WHERE github_user_id = '20'").get()).toEqual({
        github_org_role: "outside",
      });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });

      // More than one D1-sized chunk stages successfully without exposing a
      // partial live generation.
      const many = Array.from({ length: 125 }, (_, index) => ({
        id: 1_000 + index,
        login: `member-${index}`,
        avatar_url: "member.png",
      }));
      generation = "second";
      failedAdminReads = 0;
      vi.mocked(fetch).mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/42") return response({ account: { id: 7, login: "acme", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/42/access_tokens" && init?.method === "POST") return response({ token: "installation-token" });
        if (url.pathname === "/installation/repositories") return response({ total_count: 1, repositories: [{ id: 99, full_name: "acme/repo", default_branch: "main" }] });
        if (path.startsWith("/orgs/acme/members?role=admin")) return response([]);
        if (path.startsWith("/orgs/acme/members?role=member")) {
          const page = Number(url.searchParams.get("page"));
          return response(page === 1 ? many.slice(0, 100) : many.slice(100));
        }
        if (url.pathname === "/orgs/acme/outside_collaborators" || url.pathname === "/orgs/acme/teams") return response([]);
        if (path.startsWith("/repos/acme/repo/collaborators?affiliation=all")) {
          const page = Number(url.searchParams.get("page"));
          const collaborators = many.map((member) => ({
            id: member.id,
            login: member.login,
            role_name: "read",
            permissions: { pull: true },
          }));
          return response(page === 1 ? collaborators.slice(0, 100) : collaborators.slice(100));
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      // A crash after one durable staging chunk must leave the previous live
      // authority intact and must not strand a repository-linked snapshot.
      batchCalls = 0;
      failBatchAt = 2;
      await expect(syncInstallation(env, "42")).rejects.toThrow("injected staged batch failure");
      expect(t.raw.prepare("SELECT COUNT(*) n FROM principals WHERE github_org_role = 'member'").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });

      failBatchAt = null;
      batchCalls = 0;
      // A process can die without running `finally`. The next successful sync
      // reaps that bounded orphan before it stages a new generation.
      t.raw.prepare(
        "INSERT INTO github_sync_snapshots (id, organization_id, installation_id, created_at) VALUES ('crashed-snapshot', 'org_gh_7', '42', '2000-01-01T00:00:00.000Z')",
      ).run();
      t.raw.prepare(
        "INSERT INTO github_sync_grants (snapshot_id, github_repository_id, project_id, github_user_id, github_login, permission) VALUES ('crashed-snapshot', '99', 'stale_project', '999', 'stale', 'admin')",
      ).run();
      await expect(syncInstallation(env, "42")).resolves.toMatchObject({ members: 125, grants: 125 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM principals WHERE github_org_role = 'member'").get()).toEqual({ n: 125 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM repository_grants WHERE active = 1").get()).toEqual({ n: 125 });

      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("rechecks every collaborator authority field after the whole repository pass", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_gh_88', '88', 'churn', '88')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES ('project_a', 'org_gh_88', '101', 'churn/a', 'main')",
      ).run();
      t.raw.prepare(
        "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES ('project_a', '9', 'alice', 'admin')",
      ).run();
      let repositoryBWasRead = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/88") return response({ account: { id: 88, login: "churn", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/88/access_tokens" && init?.method === "POST") return response({ token: "installation-token" });
        if (url.pathname === "/installation/repositories") return response({
          total_count: 2,
          repositories: [
            { id: 101, full_name: "churn/a", default_branch: "main" },
            { id: 102, full_name: "churn/b", default_branch: "main" },
          ],
        });
        if (path.startsWith("/orgs/churn/members?role=") || url.pathname === "/orgs/churn/outside_collaborators" || url.pathname === "/orgs/churn/teams") return response([]);
        if (url.pathname === "/repos/churn/a/collaborators") return response([{
          id: 9,
          login: "alice",
          role_name: repositoryBWasRead ? "read" : "admin",
          permissions: repositoryBWasRead ? { pull: true } : { admin: true },
        }]);
        if (url.pathname === "/repos/churn/b/collaborators") {
          repositoryBWasRead = true;
          return response([]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "88")).rejects.toThrow("changed installation authority before publication");
      expect(t.raw.prepare("SELECT permission, active FROM repository_grants WHERE project_id = 'project_a'").get()).toEqual({
        permission: "admin",
        active: 1,
      });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("revalidates authority after staging before it publishes live access", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_87', '87', 'late-change', '87', 'active')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES ('late-project', 'org_gh_87', '103', 'late-change/repo', 'main')",
      ).run();
      t.raw.prepare(
        "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES ('late-project', '9', 'alice', 'admin')",
      ).run();
      let collaboratorReads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/87") return response({ account: { id: 87, login: "late-change", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/87/access_tokens" && init?.method === "POST") return response({ token: "installation-token" });
        if (url.pathname === "/installation/repositories") return response({
          total_count: 1,
          repositories: [{ id: 103, full_name: "late-change/repo", default_branch: "main" }],
        });
        if (path.startsWith("/orgs/late-change/members?role=") || url.pathname === "/orgs/late-change/outside_collaborators" || url.pathname === "/orgs/late-change/teams") return response([]);
        if (url.pathname === "/repos/late-change/repo/collaborators") {
          collaboratorReads += 1;
          return response([{
            id: 9,
            login: "alice",
            role_name: collaboratorReads <= 2 ? "admin" : "read",
            permissions: collaboratorReads <= 2 ? { admin: true } : { pull: true },
          }]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "87")).rejects.toThrow("changed installation authority before publication");
      expect(t.raw.prepare(
        "SELECT permission, active FROM repository_grants WHERE project_id = 'late-project'",
      ).get()).toEqual({ permission: "admin", active: 1 });
      expect(t.raw.prepare("SELECT COUNT(*) AS n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_87'").get()).toEqual({ status: "active" });
    } finally {
      t.close();
    }
  });

  it("does not publish a snapshot when repository selection changes during the authority walk", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_89', '89', 'selection', '89', 'suspended')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('old_project', 'org_gh_89', '201', 'selection/old', 'main', 1)",
      ).run();
      t.raw.prepare(
        "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission) VALUES ('old_project', '7', 'alice', 'admin')",
      ).run();
      let repositoryReads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/89") {
          return response({ account: { id: 89, login: "selection", type: "Organization" }, repository_selection: "selected" });
        }
        if (url.pathname === "/app/installations/89/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          repositoryReads += 1;
          const repository = repositoryReads <= 2
            ? { id: 201, full_name: "selection/old", default_branch: "main" }
            : { id: 202, full_name: "selection/new", default_branch: "main" };
          return response({ total_count: 1, repositories: [repository] });
        }
        if (path.startsWith("/orgs/selection/members?role=") || url.pathname === "/orgs/selection/outside_collaborators" || url.pathname === "/orgs/selection/teams") return response([]);
        if (url.pathname === "/repos/selection/old/collaborators") return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "89")).rejects.toThrow(
        "changed the installation repositories before authority publication",
      );

      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_89'").get()).toEqual({ status: "suspended" });
      expect(t.raw.prepare("SELECT id, enabled FROM projects WHERE organization_id = 'org_gh_89'").all()).toEqual([
        { id: "old_project", enabled: 1 },
      ]);
      expect(t.raw.prepare("SELECT permission, active FROM repository_grants WHERE project_id = 'old_project'").get()).toEqual({
        permission: "admin",
        active: 1,
      });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("projects a suspension discovered at the final authority boundary without publishing stale state", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_90', '90', 'suspend-race', '90', 'active')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('suspended_project', 'org_gh_90', '301', 'suspend-race/repo', 'main', 1)",
      ).run();
      let installationReads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/90") {
          installationReads += 1;
          return response({
            account: { id: 90, login: "suspend-race", type: "Organization" },
            repository_selection: "selected",
            suspended_at: installationReads === 1 ? null : "2026-08-12T12:00:00Z",
          });
        }
        if (url.pathname === "/app/installations/90/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({
            total_count: 1,
            repositories: [{ id: 301, full_name: "suspend-race/repo", default_branch: "main" }],
          });
        }
        if (path.startsWith("/orgs/suspend-race/members?role=") || url.pathname === "/orgs/suspend-race/outside_collaborators" || url.pathname === "/orgs/suspend-race/teams") return response([]);
        if (url.pathname === "/repos/suspend-race/repo/collaborators") return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "90")).rejects.toThrow(
        "changed installation 90 while its authority was being read",
      );

      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_90'").get()).toEqual({ status: "suspended" });
      expect(t.raw.prepare("SELECT id, enabled FROM projects WHERE organization_id = 'org_gh_90'").all()).toEqual([
        { id: "suspended_project", enabled: 1 },
      ]);
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("keeps the same GitHub user isolated in two organizations without principal id collisions", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_gh_7', '7', 'alpha', '42')",
      ).run();
      t.raw.prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role) VALUES ('prn_gh_20', 'org_gh_7', '20', 'old-login', 'outside')",
      ).run();

      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        const installation = url.pathname.match(/^\/app\/installations\/(42|43)$/)?.[1];
        if (installation !== undefined) {
          const alpha = installation === "42";
          return response({
            account: { id: alpha ? 7 : 8, login: alpha ? "alpha" : "beta", type: "Organization" },
            repository_selection: "selected",
          });
        }
        if (/^\/app\/installations\/(42|43)\/access_tokens$/.test(url.pathname) && init?.method === "POST") {
          return response({ token: url.pathname.includes("42") ? "alpha-token" : "beta-token" });
        }
        const alpha = (init?.headers as Record<string, string> | undefined)?.authorization === "Bearer alpha-token";
        const org = alpha ? "alpha" : "beta";
        const repositoryId = alpha ? 401 : 402;
        if (url.pathname === "/installation/repositories") {
          return response({
            total_count: 1,
            repositories: [{ id: repositoryId, full_name: `${org}/repo`, default_branch: "main" }],
          });
        }
        if (path.startsWith(`/orgs/${org}/members?role=admin`)) return response([{ id: 20, login: "shared", avatar_url: "shared.png" }]);
        if (path.startsWith(`/orgs/${org}/members?role=member`) || url.pathname === `/orgs/${org}/outside_collaborators` || url.pathname === `/orgs/${org}/teams`) return response([]);
        if (url.pathname === `/repos/${org}/repo/collaborators`) {
          return response([{ id: 20, login: "shared", role_name: "admin", permissions: { admin: true } }]);
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await syncInstallation(env, "42");
      await syncInstallation(env, "43");

      expect(t.raw.prepare(
        "SELECT id, organization_id, github_login, github_org_role FROM principals WHERE github_user_id = '20' ORDER BY organization_id",
      ).all()).toEqual([
        { id: "prn_gh_20", organization_id: "org_gh_7", github_login: "shared", github_org_role: "owner" },
        { id: "prn_gh_20_org_8", organization_id: "org_gh_8", github_login: "shared", github_org_role: "owner" },
      ]);
      expect(t.raw.prepare(
        "SELECT p.organization_id, p.github_repository_id, g.permission, g.active FROM repository_grants g JOIN projects p ON p.id = g.project_id WHERE g.github_user_id = '20' ORDER BY p.organization_id",
      ).all()).toEqual([
        { organization_id: "org_gh_7", github_repository_id: "401", permission: "admin", active: 1 },
        { organization_id: "org_gh_8", github_repository_id: "402", permission: "admin", active: 1 },
      ]);
    } finally {
      t.close();
    }
  });

  it("makes a transferred repository's new installation the only publisher when an old pass-three snapshot resumes", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
        EVIDENCE: {
          list: async () => ({ objects: [], truncated: false }),
          delete: async () => {},
        },
        BRANCH_QUEUE: {
          idFromName: (name: string) => name,
          get: () => ({ purge: async () => {} }),
        },
      } as unknown as Env;
      t.raw.prepare(
        `INSERT INTO organizations (id, github_org_id, github_login, installation_id, status)
         VALUES ('org_old', '801', 'old-owner', '801', 'active')`,
      ).run();
      t.raw.prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES ('old-project', 'org_old', '9901', 'old-owner/transferred', 'main', 1)`,
      ).run();
      t.raw.prepare(
        `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission)
         VALUES ('old-project', '17', 'old-user', 'admin')`,
      ).run();

      let transferred = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const auth = new Headers(init?.headers).get("authorization");
        const installation = url.pathname.match(/^\/app\/installations\/(801|802)$/)?.[1];
        if (installation !== undefined) {
          return response({
            account: {
              id: Number(installation),
              login: installation === "801" ? "old-owner" : "new-owner",
              type: "Organization",
            },
            repository_selection: "selected",
          });
        }
        const tokenInstallation = url.pathname.match(/^\/app\/installations\/(801|802)\/access_tokens$/)?.[1];
        if (tokenInstallation !== undefined && init?.method === "POST") {
          return response({ token: `${tokenInstallation}-token` });
        }
        if (url.pathname === "/installation/repositories") {
          const old = auth === "Bearer 801-token";
          const selected = old ? !transferred : transferred;
          return response({
            total_count: selected ? 1 : 0,
            repositories: selected ? [{
              id: 9901,
              full_name: old ? "old-owner/transferred" : "new-owner/transferred",
              default_branch: "main",
            }] : [],
          });
        }
        if (/^\/orgs\/(old-owner|new-owner)\/(members|outside_collaborators|teams)/.test(url.pathname)) return response([]);
        if (/^\/repos\/(old-owner|new-owner)\/transferred\/collaborators$/.test(url.pathname)) return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      });

      let oldReachedPassThree!: () => void;
      let resumeOld!: () => void;
      const atPassThree = new Promise<void>((resolve) => { oldReachedPassThree = resolve; });
      const oldGate = new Promise<void>((resolve) => { resumeOld = resolve; });
      const queued: string[] = [];
      const oldSync = syncInstallation(env, "801", {
        enqueueContinuation: async (id) => { queued.push(id); },
        afterRepositoryPassThree: async () => {
          oldReachedPassThree();
          await oldGate;
        },
      });
      await atPassThree;
      transferred = true;
      await expect(syncInstallation(env, "802", { enqueueContinuation: async (id) => { queued.push(id); } }))
        .resolves.toMatchObject({ continued: 1 });

      const afterNew = {
        projects: t.raw.prepare("SELECT id, organization_id, github_name FROM projects ORDER BY id").all(),
        grants: t.raw.prepare("SELECT project_id, github_user_id, permission, active FROM repository_grants ORDER BY project_id, github_user_id").all(),
        authority: t.raw.prepare(
          `SELECT github_repository_id, organization_id, installation_id, selected
             FROM github_repository_authority ORDER BY github_repository_id, installation_id`,
        ).all(),
        releases: t.raw.prepare(
          "SELECT github_repository_id, project_id, organization_id FROM project_release_requests ORDER BY github_repository_id",
        ).all(),
      };
      expect(afterNew.authority).toEqual([{
        github_repository_id: "9901",
        organization_id: "org_gh_802",
        installation_id: "802",
        selected: 1,
      }]);

      resumeOld();
      await expect(oldSync).resolves.toMatchObject({ continued: 1 });
      expect({
        projects: t.raw.prepare("SELECT id, organization_id, github_name FROM projects ORDER BY id").all(),
        grants: t.raw.prepare("SELECT project_id, github_user_id, permission, active FROM repository_grants ORDER BY project_id, github_user_id").all(),
        authority: t.raw.prepare(
          `SELECT github_repository_id, organization_id, installation_id, selected
             FROM github_repository_authority ORDER BY github_repository_id, installation_id`,
        ).all(),
        releases: t.raw.prepare(
          "SELECT github_repository_id, project_id, organization_id FROM project_release_requests ORDER BY github_repository_id",
        ).all(),
      }).toEqual(afterNew);
      expect(queued).toContain("801");
    } finally {
      t.close();
    }
  });

  it("refuses an installation above the supported repository bound before changing live projects", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: {
          ...t.db,
          batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
            if (statements.length > 100) throw new Error("D1 batch exceeded 100 statements");
            return t.db.batch!(statements as never);
          },
        },
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      const repositories = Array.from({ length: 501 }, (_, index) => ({
        id: 10_000 + index,
        full_name: `large/repo-${index}`,
        default_branch: "main",
      }));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/77") return response({ account: { id: 77, login: "large", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/77/access_tokens" && init?.method === "POST") return response({ token: "installation-token" });
        if (url.pathname === "/installation/repositories") {
          const page = Number(url.searchParams.get("page"));
          return response({ total_count: repositories.length, repositories: repositories.slice((page - 1) * 100, page * 100) });
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      await expect(syncInstallation(env, "77")).rejects.toThrow("supports at most 500 repositories");
      expect(t.raw.prepare("SELECT COUNT(*) n FROM projects WHERE organization_id = 'org_gh_77'").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM github_sync_snapshots").get()).toEqual({ n: 0 });
      expect(t.raw.prepare("SELECT status FROM organizations WHERE github_org_id = '77'").get()).toEqual({ status: "syncing" });
    } finally {
      t.close();
    }
  });

  it("fences a confirmed deselection before an unrelated membership read fails", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_79', '79', 'failclosed', '79', 'active')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('removed-project', 'org_gh_79', '601', 'failclosed/removed', 'main', 1)",
      ).run();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        if (url.pathname === "/app/installations/79") {
          return response({ account: { id: 79, login: "failclosed", type: "Organization" }, repository_selection: "selected" });
        }
        if (url.pathname === "/app/installations/79/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          return response({ total_count: 1, repositories: [{ id: 602, full_name: "failclosed/selected", default_branch: "main" }] });
        }
        if (url.pathname === "/orgs/failclosed/members") return new Response("rate limited", { status: 429 });
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      });

      await expect(syncInstallation(env, "79")).rejects.toThrow("429");
      expect(t.raw.prepare(
        "SELECT project_id FROM project_release_requests WHERE github_repository_id = '601'",
      ).get()).toEqual({ project_id: "removed-project" });
      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_79'").get()).toEqual({ status: "active" });
      expect(t.raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE github_repository_id = '602'").get()).toEqual({ n: 0 });
    } finally {
      t.close();
    }
  });

  it("still fences a removed project when the new selection exceeds the supported bound", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      const env = {
        DB: t.db,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      t.raw.prepare(
        "INSERT INTO organizations (id, github_org_id, github_login, installation_id, status) VALUES ('org_gh_80', '80', 'oversized', '80', 'active')",
      ).run();
      t.raw.prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled) VALUES ('removed-oversized', 'org_gh_80', '700', 'oversized/removed', 'main', 1)",
      ).run();
      const repositories = Array.from({ length: 501 }, (_, index) => ({
        id: 20_000 + index,
        full_name: `oversized/repo-${index}`,
        default_branch: "main",
      }));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        const url = new URL(String(request));
        if (url.pathname === "/app/installations/80") {
          return response({ account: { id: 80, login: "oversized", type: "Organization" }, repository_selection: "selected" });
        }
        if (url.pathname === "/app/installations/80/access_tokens" && init?.method === "POST") {
          return response({ token: "installation-token" });
        }
        if (url.pathname === "/installation/repositories") {
          const page = Number(url.searchParams.get("page"));
          return response({ total_count: repositories.length, repositories: repositories.slice((page - 1) * 100, page * 100) });
        }
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      });

      await expect(syncInstallation(env, "80")).rejects.toThrow("supports at most 500 repositories");
      expect(t.raw.prepare(
        "SELECT project_id FROM project_release_requests WHERE github_repository_id = '700'",
      ).get()).toEqual({ project_id: "removed-oversized" });
      expect(t.raw.prepare("SELECT status FROM organizations WHERE id = 'org_gh_80'").get()).toEqual({ status: "active" });
    } finally {
      t.close();
    }
  });

  it("completes the declared 500-repository maximum with 76 teams inside the request budget", async () => {
    const t = testD1();
    try {
      const pair = await generateKeyPair("RS256", { extractable: true });
      let d1Queries = 0;
      const countedDb = {
        prepare: (query: string) => {
          const statement = t.db.prepare(query);
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => { d1Queries += 1; return bound.run(); },
                first: async <T,>() => { d1Queries += 1; return bound.first<T>(); },
                all: async <T,>() => { d1Queries += 1; return bound.all<T>(); },
              };
            },
          };
        },
        batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
          if (statements.length > 100) throw new Error("D1 batch exceeded 100 statements");
          for (const statement of statements) await statement.run();
        },
      };
      const env = {
        DB: countedDb,
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      } as unknown as Env;
      const repositories = Array.from({ length: 500 }, (_, index) => ({
        id: 20_000 + index,
        full_name: `maximum/repo-${index}`,
        default_branch: "main",
      }));
      const teams = Array.from({ length: 76 }, (_, index) => ({
        id: 30_000 + index,
        slug: `team-${index}`,
        name: `Team ${index}`,
      }));
      let tokenMints = 0;
      let githubRequests = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
        githubRequests += 1;
        const url = new URL(String(request));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/app/installations/78") return response({ account: { id: 78, login: "maximum", type: "Organization" }, repository_selection: "selected" });
        if (url.pathname === "/app/installations/78/access_tokens" && init?.method === "POST") {
          tokenMints += 1;
          return response({ token: `installation-token-${tokenMints}` });
        }
        if (url.pathname === "/installation/repositories") {
          const page = Number(url.searchParams.get("page"));
          return response({
            total_count: repositories.length,
            repositories: repositories.slice((page - 1) * 100, page * 100),
          });
        }
        if (path.startsWith("/orgs/maximum/members?role=") || url.pathname === "/orgs/maximum/outside_collaborators") return response([]);
        if (url.pathname === "/orgs/maximum/teams") return response(teams);
        if (/^\/orgs\/maximum\/teams\/team-\d+\/(members|repos)$/.test(url.pathname)) return response([]);
        if (url.pathname.startsWith("/repos/maximum/repo-") && url.pathname.endsWith("/collaborators")) return response([]);
        throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${path}`);
      });

      const queued: string[] = [];
      const queuedPurposes: Array<{ reconcilePolicies: boolean; reconcileProofChecks: boolean }> = [];
      const d1QueriesPerInvocation: number[] = [];
      const githubRequestsPerInvocation: number[] = [];
      let nextPostSyncWork = { reconcilePolicies: true, reconcileProofChecks: true };
      let result;
      do {
        d1Queries = 0;
        const beforeGithub = githubRequests;
        result = await syncInstallation(env, "78", {
          postSyncWork: nextPostSyncWork,
          enqueueContinuation: async (installationId, _schedule, postSyncWork) => {
            queued.push(installationId);
            expect(postSyncWork).toBeDefined();
            nextPostSyncWork = postSyncWork!;
            queuedPurposes.push(postSyncWork!);
          },
        });
        d1QueriesPerInvocation.push(d1Queries);
        githubRequestsPerInvocation.push(githubRequests - beforeGithub);
        if (result.continued === 1) {
          expect(await drainGithubSyncSnapshots(env, 100)).toBe(0);
          expect(t.raw.prepare(
            "SELECT continuation_pending FROM github_sync_snapshots WHERE installation_id = '78'",
          ).get()).toEqual({ continuation_pending: 1 });
        }
      } while (result.continued === 1);

      expect(result).toMatchObject({ repos: 500, grants: 0, continued: 0 });
      expect(t.raw.prepare("SELECT COUNT(*) n FROM projects WHERE organization_id = 'org_gh_78'").get()).toEqual({ n: 500 });
      expect(Math.max(...d1QueriesPerInvocation)).toBeLessThan(1_000);
      expect(Math.max(...githubRequestsPerInvocation)).toBeLessThanOrEqual(80);
      expect(queued).toHaveLength(d1QueriesPerInvocation.length - 1);
      expect(new Set(queued)).toEqual(new Set(["78"]));
      expect(new Set(queuedPurposes.map((purpose) => JSON.stringify(purpose)))).toEqual(new Set([
        JSON.stringify({ reconcilePolicies: true, reconcileProofChecks: true }),
      ]));
      expect(vi.mocked(fetch).mock.calls.length).toBeLessThan(3_000);
      expect(tokenMints).toBeGreaterThanOrEqual(8);
    } finally {
      t.close();
    }
  });
});

interface QuarantineFlowOptions {
  readonly transfer: boolean;
  readonly deselectBeforeBoundary?: boolean;
}

async function runQuarantineProductionFlow({ transfer, deselectBeforeBoundary = false }: QuarantineFlowOptions): Promise<void> {
  const t = testD1();
  const removedAt = new Date("2030-01-01T00:00:00.000Z");
  const selectedAt = new Date("2030-01-01T00:05:00.000Z");
  const repositoryId = "88001";
  const oldInstallationId = "901";
  const selectedInstallationId = transfer ? "902" : oldInstallationId;
  const oldOrganizationId = "org_gh_901";
  const selectedOrganizationId = transfer ? "org_gh_902" : oldOrganizationId;
  const oldProjectId = "old-quarantine-project";
  const remoteSelection = new Map<string, boolean>([
    [oldInstallationId, false],
    ...(transfer ? [[selectedInstallationId, true] as const] : []),
  ]);
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(removedAt);
    const pair = await generateKeyPair("RS256", { extractable: true });
    const env = {
      DB: t.db,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      EVIDENCE: {
        list: async () => ({ objects: [], truncated: false }),
        delete: async () => {},
        head: async () => null,
      },
      BRANCH_QUEUE: {
        idFromName: (name: string) => name,
        get: () => ({ purge: async () => {} }),
      },
    } as unknown as Env;
    t.raw.prepare(
      `INSERT INTO organizations (id, github_org_id, github_login, installation_id, status)
       VALUES (?, '901', 'old-owner', ?, 'active')`,
    ).run(oldOrganizationId, oldInstallationId);
    t.raw.prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled)
       VALUES (?, ?, ?, 'old-owner/repository', 'main', 1)`,
    ).run(oldProjectId, oldOrganizationId, repositoryId);
    t.raw.prepare(
      `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active)
       VALUES (?, '77', 'old-user', 'admin', 1)`,
    ).run(oldProjectId);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = new URL(String(request));
      const installationId = url.pathname.match(/^\/app\/installations\/(901|902)$/)?.[1];
      if (installationId !== undefined) {
        return response({
          account: {
            id: Number(installationId),
            login: installationId === oldInstallationId ? "old-owner" : "new-owner",
            type: "Organization",
          },
          repository_selection: "selected",
        });
      }
      const tokenInstallationId = url.pathname.match(/^\/app\/installations\/(901|902)\/access_tokens$/)?.[1];
      if (tokenInstallationId !== undefined && init?.method === "POST") {
        return response({ token: `${tokenInstallationId}-token` });
      }
      if (url.pathname === "/installation/repositories") {
        const token = new Headers(init?.headers).get("authorization")?.match(/^Bearer (901|902)-token$/)?.[1];
        if (token === undefined) throw new Error("installation repository request had no scoped token");
        const selected = remoteSelection.get(token) === true;
        const owner = token === oldInstallationId ? "old-owner" : "new-owner";
        return response({
          total_count: selected ? 1 : 0,
          repositories: selected ? [{
            id: Number(repositoryId),
            full_name: `${owner}/repository`,
            default_branch: "main",
          }] : [],
        });
      }
      if (/^\/orgs\/(old-owner|new-owner)\/(members|outside_collaborators|teams)$/.test(url.pathname)) {
        return response([]);
      }
      if (/^\/repos\/(old-owner|new-owner)\/repository\/collaborators$/.test(url.pathname)) {
        return response([]);
      }
      throw new Error(`unexpected GitHub request ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    });

    await expect(syncInstallation(env, oldInstallationId, { enqueueContinuation: async () => {} }))
      .resolves.toMatchObject({ continued: 0 });
    expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(repositoryId)).toBeUndefined();
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM repository_grants WHERE project_id = ?").get(oldProjectId))
      .toEqual({ count: 0 });
    const quarantine = t.raw.prepare(
      `SELECT organization_id AS organizationId, reimport_not_before AS notBefore
         FROM project_reimport_quarantines WHERE github_repository_id = ?`,
    ).get(repositoryId) as { organizationId: string; notBefore: string };
    expect(quarantine).toEqual({
      organizationId: oldOrganizationId,
      notBefore: "2030-01-01T01:00:00.000Z",
    });

    if (!transfer) remoteSelection.set(oldInstallationId, true);
    vi.setSystemTime(selectedAt);
    const delayed: Array<{
      installationId: string;
      schedule: { delaySeconds: number; notBefore: string } | undefined;
    }> = [];
    await expect(syncInstallation(env, selectedInstallationId, {
      now: () => selectedAt,
      enqueueContinuation: async (installationId, schedule) => {
        delayed.push({ installationId, schedule });
      },
    })).resolves.toMatchObject({ continued: 1 });
    expect(delayed).toEqual([{
      installationId: selectedInstallationId,
      schedule: { delaySeconds: 55 * 60, notBefore: quarantine.notBefore },
    }]);
    expect(t.raw.prepare(
      `SELECT continuation_pending AS pending, continuation_not_before AS notBefore
         FROM github_sync_snapshots WHERE installation_id = ?`,
    ).get(selectedInstallationId)).toEqual({ pending: 1, notBefore: quarantine.notBefore });
    expect(await pendingProjectReimports(t.db, selectedOrganizationId)).toEqual({
      count: 1,
      readyAt: quarantine.notBefore,
    });
    if (transfer) {
      expect(await pendingProjectReimports(t.db, oldOrganizationId)).toEqual({ count: 0, readyAt: null });
    }
    expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(repositoryId)).toBeUndefined();
    expect(t.raw.prepare(
      "SELECT COUNT(*) AS count FROM repository_grants WHERE github_user_id = '77' AND active = 1",
    ).get()).toEqual({ count: 0 });
    const scheduled: string[] = [];

    if (deselectBeforeBoundary) {
      remoteSelection.set(selectedInstallationId, false);
      const deselectedAt = new Date("2030-01-01T00:30:00.000Z");
      vi.setSystemTime(deselectedAt);
      let result;
      do {
        result = await syncInstallation(env, selectedInstallationId, {
          now: () => deselectedAt,
          enqueueContinuation: async () => {},
        });
      } while (result.continued === 1);
      expect(await pendingProjectReimports(t.db, selectedOrganizationId)).toEqual({ count: 0, readyAt: null });
      expect(t.raw.prepare(
        `SELECT selected FROM github_repository_authority
          WHERE github_repository_id = ? AND installation_id = ?`,
      ).get(repositoryId, selectedInstallationId)).toEqual({ selected: 0 });
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(repositoryId)).toBeUndefined();

      const boundary = new Date(quarantine.notBefore);
      vi.setSystemTime(boundary);
      expect(await enqueueDueProjectReimportReconciliation(env, {
        now: () => boundary,
        enqueueBatch: async (messages) => scheduled.push(...messages.map((message) => message.installationId)),
      })).toEqual([]);
      await expect(syncInstallation(env, selectedInstallationId, {
        now: () => boundary,
        enqueueContinuation: async () => {},
      })).resolves.toMatchObject({ continued: 0 });
      await expect(drainProjectReleases(env, 10, { now: () => boundary }))
        .resolves.toEqual({ attempted: 0, released: 0, failed: 0 });
      expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(repositoryId)).toBeUndefined();
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM project_reimport_quarantines WHERE github_repository_id = ?",
      ).get(repositoryId)).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_authority WHERE github_repository_id = ?",
      ).get(repositoryId)).toEqual({ count: 0 });
      expect(t.raw.prepare(
        "SELECT COUNT(*) AS count FROM github_repository_reconcile_leases WHERE github_repository_id = ?",
      ).get(repositoryId)).toEqual({ count: 0 });
      expect(await pendingProjectReimports(t.db, selectedOrganizationId)).toEqual({ count: 0, readyAt: null });
      return;
    }

    const early = new Date(Date.parse(quarantine.notBefore) - 1);
    expect(await enqueueDueProjectReimportReconciliation(env, {
      now: () => early,
      enqueueBatch: async (messages) => scheduled.push(...messages.map((message) => message.installationId)),
    })).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(t.raw.prepare("SELECT id FROM projects WHERE github_repository_id = ?").get(repositoryId)).toBeUndefined();

    const boundary = new Date(quarantine.notBefore);
    vi.setSystemTime(boundary);
    // Production scheduled order drains abandoned snapshots first. A live
    // delayed continuation must survive that pass before the due fallback is
    // enqueued.
    await expect(drainGithubSyncSnapshots(env, 100)).resolves.toBe(0);
    expect(t.raw.prepare(
      `SELECT continuation_pending AS pending, continuation_not_before AS notBefore
         FROM github_sync_snapshots WHERE installation_id = ?`,
    ).get(selectedInstallationId)).toEqual({ pending: 1, notBefore: quarantine.notBefore });
    expect(await enqueueDueProjectReimportReconciliation(env, {
      now: () => boundary,
      enqueueBatch: async (messages) => scheduled.push(...messages.map((message) => message.installationId)),
    })).toEqual([selectedInstallationId]);
    // A second five-minute firing can enqueue the same authoritative sync
    // before the first delivery completes. Both messages are safe and the
    // lifecycle remains idempotent.
    expect(await enqueueDueProjectReimportReconciliation(env, {
      now: () => boundary,
      enqueueBatch: async (messages) => scheduled.push(...messages.map((message) => message.installationId)),
    })).toEqual([selectedInstallationId]);
    expect(scheduled).toEqual([selectedInstallationId, selectedInstallationId]);
    await expect(drainProjectReleases(env, 10, { now: () => boundary }))
      .resolves.toEqual({ attempted: 0, released: 0, failed: 0 });
    expect(t.raw.prepare(
      "SELECT reimport_not_before FROM project_reimport_quarantines WHERE github_repository_id = ?",
    ).get(repositoryId)).toEqual({ reimport_not_before: quarantine.notBefore });

    await expect(syncInstallation(env, selectedInstallationId, {
      now: () => boundary,
      enqueueContinuation: async () => {},
    })).resolves.toMatchObject({ continued: 0 });
    const imported = t.raw.prepare(
      `SELECT id, organization_id AS organizationId, github_name AS githubName, enabled
         FROM projects WHERE github_repository_id = ?`,
    ).get(repositoryId) as { id: string; organizationId: string; githubName: string; enabled: number };
    expect(imported).toMatchObject({
      organizationId: selectedOrganizationId,
      githubName: transfer ? "new-owner/repository" : "old-owner/repository",
      enabled: 0,
    });
    expect(imported.id).not.toBe(oldProjectId);
    expect(await pendingProjectReimports(t.db, selectedOrganizationId)).toEqual({ count: 0, readyAt: null });
    expect(t.raw.prepare(
      "SELECT COUNT(*) AS count FROM project_reimport_quarantines WHERE github_repository_id = ?",
    ).get(repositoryId)).toEqual({ count: 0 });
    expect(t.raw.prepare(
      "SELECT COUNT(*) AS count FROM github_sync_snapshots WHERE installation_id = ?",
    ).get(selectedInstallationId)).toEqual({ count: 0 });

    expect(await enqueueDueProjectReimportReconciliation(env, {
      now: () => boundary,
      enqueueBatch: async (messages) => scheduled.push(...messages.map((message) => message.installationId)),
    })).toEqual([]);
    await expect(syncInstallation(env, selectedInstallationId, {
      now: () => boundary,
      enqueueContinuation: async () => {},
    })).resolves.toMatchObject({ continued: 0 });
    expect(t.raw.prepare("SELECT id, enabled FROM projects WHERE github_repository_id = ?").get(repositoryId))
      .toEqual({ id: imported.id, enabled: 0 });
    expect(scheduled).toEqual([selectedInstallationId, selectedInstallationId]);
  } finally {
    t.close();
  }
}

describe("quarantined GitHub repository reimports", () => {
  it("shows and imports a same-organization re-selection at the exact capability boundary", async () => {
    await runQuarantineProductionFlow({ transfer: false });
  });

  it("shows a transfer only to the selected new organization and imports it at the exact boundary", async () => {
    await runQuarantineProductionFlow({ transfer: true });
  });

  it("collects a same-organization re-selection that GitHub removes again before the boundary", async () => {
    await runQuarantineProductionFlow({ transfer: false, deselectBeforeBoundary: true });
  });

  it("collects a transferred re-selection that GitHub removes again before the boundary", async () => {
    await runQuarantineProductionFlow({ transfer: true, deselectBeforeBoundary: true });
  });
});
