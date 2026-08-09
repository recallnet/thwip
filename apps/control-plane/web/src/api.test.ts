import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api.js";

/**
 * What a reader is told when the control plane says no.
 *
 * The helper read `{ error }` and nothing else, so a route that explained itself
 * in a `detail` sentence had that sentence dropped and the reader was shown the
 * status code. The queue's administrative routes did exactly that, and the
 * dashboard's answer was to stop using this helper for them, which leaves the
 * next route to discover the same wall.
 *
 * The rule here is that a refusal never reaches a person as a number.
 */

const originalFetch = globalThis.fetch;

// The suite runs under node, where the helper's one browser dependency is the
// selected organization it reads before every request.
const held = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => held.get(key) ?? null,
  setItem: (key: string, value: string) => void held.set(key, value),
  removeItem: (key: string) => void held.delete(key),
  clear: () => held.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

afterEach(() => {
  globalThis.fetch = originalFetch;
  held.clear();
});

function refuses(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("what a refusal says", () => {
  it("prefers the sentence a route wrote over the code beside it", async () => {
    refuses(409, { error: "RESUME_REFUSED", detail: "a rebaseline is required before the queue may resume" });
    await expect(api("/v1/queue/1/resume", { method: "POST" })).rejects.toThrow(
      "a rebaseline is required before the queue may resume",
    );
  });

  /**
   * Most routes carry only `{ error }`, and half of those hold a code rather
   * than a sentence. `SUBJECT_BASE_MISMATCH` on screen is the same failure as a
   * bare 409: something a person has to go and look up.
   */
  it("says a screaming code as words when that is all a route sent", async () => {
    refuses(403, { error: "REPOSITORY_READ_ONLY" });
    await expect(api("/v1/queue/1/pause", { method: "POST" })).rejects.toThrow("Repository read only");
  });

  it("keeps an ordinary sentence as it was written", async () => {
    refuses(400, { error: "a pause requires a reason" });
    await expect(api("/v1/queue/1/pause", { method: "POST" })).rejects.toThrow("a pause requires a reason");
  });

  /**
   * A body with nothing in it still has to say something. The status alone is
   * what this whole helper exists to stop reaching a reader.
   */
  it("says what a bare status means rather than printing the number", async () => {
    refuses(503, {});
    const failed = await api("/v1/dashboard/summary").catch((e: ApiError) => e);
    expect((failed as ApiError).message).not.toBe("503");
    expect((failed as ApiError).message.length).toBeGreaterThan(3);
  });

  it("carries the status so a caller can still tell refusal from breakage", async () => {
    refuses(403, { error: "forbidden" });
    const failed = (await api("/v1/dashboard/summary").catch((e: ApiError) => e)) as ApiError;
    expect(failed.status).toBe(403);
  });
});
