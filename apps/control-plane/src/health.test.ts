import { exportJWK, generateKeyPair } from "jose";
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
      jws: expect.any(String),
    });
  });
});
