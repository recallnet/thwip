import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction } from "./main.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe("the trusted candidate-report entry point", () => {
  it("validates the event, obtains OIDC and sends only the nonce", async () => {
    const eventPath = join(mkdtempSync(join(tmpdir(), "thwip-action-smoke-")), "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "thwip-queue-verify",
        repository: { id: 12 },
        client_payload: {
          dispatchNonce: "nonce",
          workflowCommitSha: "workflow-sha",
          candidateSha: "must-not-cross-the-boundary",
        },
      }),
    );
    process.env = {
      ...originalEnv,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_WORKFLOW_SHA: "workflow-sha",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      INPUT_ENDPOINT: "https://thwip.example",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "oidc" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(runAction()).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ dispatchNonce: "nonce" }));
  });
});
