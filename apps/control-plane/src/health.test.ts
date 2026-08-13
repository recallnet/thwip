import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import worker from "./index.js";
import type { Env } from "./env.js";

// `index.ts` re-exports the Worker-only Durable Object class. This route test
// runs in Node and never touches that binding, so keep the Worker-only import
// out of this test process.
vi.mock("./queue/BranchQueue.js", () => ({ BranchQueue: class {} }));

/**
 * `/health` is the clock outside Cloudflare that detects a stopped queue.
 * Caching it can present an old build and an old clock as current, so the cache
 * contract is as important as the signed body.
 */
describe("the public health signal", () => {
  let opened: TestD1 | null = null;

  afterEach(() => {
    opened?.close();
    opened = null;
  });

  it("cannot be served from a cache", async () => {
    opened = testD1();
    opened.raw.prepare(
      `UPDATE project_lifecycle_rollout
          SET worker_activated_at = NULL, remote_capabilities_retired_at = NULL,
              remote_capability_evidence = NULL, destructive_schema_ready_at = NULL
        WHERE id = 1`,
    ).run();
    const now = new Date().toISOString();
    opened.raw
      .prepare("UPDATE queue_clock SET started_at = ?, finished_at = ?, source = 'cron' WHERE id = 'tick'")
      .run(now, now);

    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: `health-test-${crypto.randomUUID()}`,
      alg: "ES256",
    };
    const env = {
      DB: opened.db,
      THWIP_ENV: "test",
      BUILD_SHA: "health-test-build",
      DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001",
      THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const execution = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext;

    const response = await worker.fetch(new Request("https://thwip.test/health"), env, execution);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      service: "thwip",
      env: "test",
      buildSha: "health-test-build",
      projectLifecycle: {
        maintenanceMode: false,
        workerActivatedAt: expect.any(String),
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
      schema: {
        phase: "current",
        selected: [],
        deployBlockers: [],
        blockedBehindBarrier: [],
        outOfOrderApplied: [],
        capabilities: {
          privateAgentFeedback: true,
          verifierProtocolV3: true,
          lifecycleReopened: true,
        },
      },
      jws: expect.any(String),
    });
  });

  it("re-enqueues an installation sync at GitHub's primary rate-limit reset", async () => {
    opened = testD1();
    const pair = await generateKeyPair("RS256", { extractable: true });
    const sends = vi.fn(async (_body: unknown, _options?: { delaySeconds: number }) => undefined);
    const acknowledge = vi.fn();
    const retry = vi.fn();
    const resetAt = Math.floor(Date.now() / 1_000) + 600;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("primary rate limit exhausted", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        },
      }),
    );
    const body = { installationId: "42", syncInstallation: true };
    const env = {
      DB: opened.db,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
      SYNC_QUEUE: { send: sends },
    } as unknown as Env;

    await worker.queue(
      { messages: [{ body, ack: acknowledge, retry }] } as unknown as MessageBatch,
      env,
    );

    expect(sends).toHaveBeenCalledOnce();
    expect(sends.mock.calls[0]?.[0]).toEqual(body);
    const delaySeconds = (sends.mock.calls[0]?.[1] as { delaySeconds?: number } | undefined)?.delaySeconds;
    expect(delaySeconds).toBeGreaterThanOrEqual(600);
    expect(delaySeconds).toBeLessThanOrEqual(602);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("serves only health and schema during the in-place lifecycle rebuild", async () => {
    opened = testD1({ upTo: "0031_finish_github_repository_lifecycle.sql" });
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: `maintenance-test-${crypto.randomUUID()}`,
      alg: "ES256",
    };
    const sends = vi.fn(async (_body: unknown, _options?: { delaySeconds: number }) => undefined);
    const env = {
      DB: opened.db,
      THWIP_ENV: "test",
      BUILD_SHA: "maintenance-test-build",
      DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000002",
      THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      SYNC_QUEUE: { send: sends },
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const execution = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    // Seed the public signing key before the database-level fence closes.
    expect((await worker.fetch(new Request("https://thwip.test/health"), env, execution)).status).toBe(200);
    await Promise.all(pending.splice(0));
    opened.raw.prepare("UPDATE project_lifecycle_rollout SET maintenance_mode = 1 WHERE id = 1").run();

    const blocked = await worker.fetch(new Request("https://thwip.test/v1/metrics"), env, execution);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("300");
    const health = await worker.fetch(new Request("https://thwip.test/health"), env, execution);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ projectLifecycle: { maintenanceMode: true } });
    expect((await worker.fetch(new Request("https://thwip.test/v1/schema"), env, execution)).status).toBe(200);

    const acknowledge = vi.fn();
    const retry = vi.fn();
    const body = { installationId: "42", syncInstallation: true };
    await worker.queue(
      { messages: [{ body, ack: acknowledge, retry }] } as unknown as MessageBatch,
      env,
    );
    expect(sends).toHaveBeenCalledWith(body, { delaySeconds: 300 });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps every service entry point fenced between 0031 and 0034", async () => {
    opened = testD1({ upTo: "0034_reopen_after_project_lifecycle.sql", rollout: "as-migrated" });
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: `schema-gap-${crypto.randomUUID()}`,
      alg: "ES256",
    };
    const sends = vi.fn(async (_body: unknown, _options?: { delaySeconds: number }) => undefined);
    const env = {
      DB: opened.db,
      THWIP_ENV: "test",
      BUILD_SHA: "schema-gap-build",
      DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000003",
      THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      SYNC_QUEUE: { send: sends },
    } as unknown as Env;
    const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    expect((await worker.fetch(new Request("https://thwip.test/v1/metrics"), env, execution)).status).toBe(503);
    const health = await worker.fetch(new Request("https://thwip.test/health"), env, execution);
    await expect(health.json()).resolves.toMatchObject({
      projectLifecycle: {
        maintenanceMode: true,
        workerBuildSha: "schema-gap-build",
        workerDeploymentId: "00000000-0000-4000-8000-000000000003",
        verifierV3PredeployId: "00000000-0000-4000-8000-000000000001",
      },
      schema: {
        phase: "after-worker",
        selected: ["0034_reopen_after_project_lifecycle.sql"],
        capabilities: {
          lifecycleFinished: true,
          privateAgentFeedback: true,
          verifierProtocolV3: true,
          lifecycleReopened: false,
        },
      },
    });
    const schema = await worker.fetch(new Request("https://thwip.test/v1/schema"), env, execution);
    await expect(schema.json()).resolves.toMatchObject({
      schema: { phase: "after-worker", selected: ["0034_reopen_after_project_lifecycle.sql"] },
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const body = { installationId: "42", syncInstallation: true };
    await worker.queue({ messages: [{ body, ack, retry }] } as unknown as MessageBatch, env);
    expect(sends).toHaveBeenCalledWith(body, { delaySeconds: 300 });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    await expect(worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, env)).resolves.toBeUndefined();
  });
});
