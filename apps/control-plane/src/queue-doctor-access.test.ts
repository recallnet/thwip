import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import type { Env } from "./env.js";

vi.mock("./queue/BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("./auth.js", () => ({
  createAuth: () => ({
    api: { getSession: async () => ({ user: { id: "ba_outside" } }) },
    handler: async () => new Response("not used", { status: 404 }),
  }),
}));

const { default: worker } = await import("./index.js");
const opened: TestD1[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (opened.length > 0) opened.pop()!.close();
});

async function environment(permission: "admin" | "read"): Promise<Env> {
  const t = testD1();
  opened.push(t);
  const now = new Date().toISOString();
  t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'acme')").run();
  t.raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch)
       VALUES ('project_1', 'org_1', '1315419165', 'acme/repo', 'main')`,
    )
    .run();
  t.raw
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('ba_outside', 'Olivia', 'olivia@example.com', 1, ?, ?)`,
    )
    .run(now, now);
  t.raw
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
       VALUES ('account_1', '77', 'github', 'ba_outside', ?, ?)`,
    )
    .run(now, now);
  t.raw
    .prepare(
      `INSERT INTO principals
         (id, organization_id, github_user_id, github_login, github_org_role, activated_at)
       VALUES ('principal_outside', 'org_1', '77', 'olivia', 'outside', ?)`,
    )
    .run(now);
  t.raw
    .prepare(
      `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active, synced_at)
       VALUES ('project_1', '77', 'olivia', ?, 1, ?)`,
    )
    .run(permission, now);
  const pair = await generateKeyPair("RS256", { extractable: true });
  return {
    DB: t.db,
    GITHUB_APP_ID: "31415",
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    PUBLIC_ORIGIN: "https://thwip.test",
  } as unknown as Env;
}

async function doctor(env: Env, projectId: string | null = "project_1"): Promise<Response> {
  const query = projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`;
  return worker.fetch(
    new Request(`https://thwip.test/v1/queue/1315419165/doctor${query}`),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

describe("queue doctor repository administration", () => {
  it("lets an outside collaborator with repository admin reach the diagnostic", async () => {
    const env = await environment("admin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("GitHub unavailable", { status: 503 }));

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("still refuses an outside collaborator without repository admin", async () => {
    const env = await environment("read");

    const response = await doctor(env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "repository admin required" });
  });

  it("requires and rechecks the exact project incarnation", async () => {
    const env = await environment("admin");

    const missing = await doctor(env, null);
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "projectId is required" });

    const stale = await doctor(env, "project_old");
    expect(stale.status).toBe(404);
    await expect(stale.json()).resolves.toEqual({ error: "unknown repository" });
  });
});
