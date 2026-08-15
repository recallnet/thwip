import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import type { Env } from "./env.js";

vi.mock("./queue/BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("./auth.js", () => ({
  createAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get("authorization") === "Bearer user-session" ? { user: { id: "ba_user" } } : null,
    },
    handler: async () => new Response("not used", { status: 404 }),
  }),
}));

const { default: worker } = await import("./index.js");
const opened: TestD1[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function environment(): { t: TestD1; env: Env } {
  const t = testD1();
  opened.push(t);
  const now = new Date().toISOString();
  t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org', '10', 'acme')").run();
  t.raw
    .prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
              VALUES ('ba_user', 'Alice', 'alice@example.com', 1, ?, ?)`).run(now, now);
  t.raw
    .prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
              VALUES ('account', '4242', 'github', 'ba_user', ?, ?)`).run(now, now);
  t.raw
    .prepare(`INSERT INTO principals
              (id, organization_id, github_user_id, github_login, github_org_role, activated_at)
              VALUES ('principal', 'org', '4242', 'alice', 'member', NULL)`).run();
  return { t, env: { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as Env };
}

async function request(env: Env, authorization?: string): Promise<Response> {
  return worker.fetch(
    new Request("https://thwip.test/v1/session/identity", authorization ? { headers: { authorization } } : {}),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

describe("read-only CLI session identity", () => {
  it("requires a session and returns its GitHub id without activating a seat", async () => {
    const { t, env } = environment();
    expect((await request(env)).status).toBe(401);
    const before = t.raw.prepare("SELECT better_auth_user_id, activated_at FROM principals WHERE id = 'principal'").get();

    const response = await request(env, "Bearer user-session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ githubUserId: "4242" });
    const after = t.raw.prepare("SELECT better_auth_user_id, activated_at FROM principals WHERE id = 'principal'").get();
    expect(after).toEqual(before);
  });
});
