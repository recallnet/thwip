import { describe, expect, it, vi } from "vitest";
import { ActionClient } from "./control-plane.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetch: typeof globalThis.fetch, sleep = vi.fn(async () => undefined)): ActionClient {
  return new ActionClient({
    endpoint: "https://thwip.example",
    githubApiUrl: "https://api.github.example",
    githubToken: "github-token",
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?api-version=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    },
    fetch,
    sleep,
    log: vi.fn(),
  });
}

describe("control-plane calls", () => {
  it("uses one OIDC token for repeated calls", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { value: "oidc" }))
      .mockResolvedValueOnce(json(200, { reason: "AUTHORIZED" }))
      .mockResolvedValueOnce(json(202, {}));
    const api = client(fetch);
    await api.authorize({
      repositoryId: "12",
      pullRequestNumber: 34,
      headSha: "head",
      baseRef: "refs/heads/main",
      authorGithubUserId: "56",
      draft: false,
    });
    await api.controlPlane("/observation", {});
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "audience=https%3A%2F%2Fthwip.example%2Fapi%2Fgithub-actions",
    );
  });

  it("retries temporary queue failures and keeps the same request", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { value: "oidc" }))
      .mockResolvedValueOnce(json(503, { code: "BUSY" }))
      .mockResolvedValueOnce(json(200, { reason: "WAITING" }));
    const api = client(fetch, sleep);
    await expect(
      api.authorize({
        repositoryId: "12",
        pullRequestNumber: 34,
        headSha: "head",
        baseRef: "refs/heads/main",
        authorGithubUserId: "56",
        draft: true,
      }),
    ).resolves.toBe("WAITING");
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[2]?.[1]?.body);
  });

  it("reports only the dispatch nonce after checking the workflow commit", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { value: "oidc" }))
      .mockResolvedValueOnce(json(202, {}));
    const api = client(fetch);
    await api.reportCandidate({
      repositoryId: "12",
      dispatchNonce: "nonce",
      expectedWorkflowSha: "same",
      actualWorkflowSha: "same",
    });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ dispatchNonce: "nonce" }));
    await expect(
      api.reportCandidate({
        repositoryId: "12",
        dispatchNonce: "nonce",
        expectedWorkflowSha: "expected",
        actualWorkflowSha: "other",
      }),
    ).rejects.toThrow("did not start from the dispatched workflow commit");
  });

  it("does not send a GitHub request without the declared token input", async () => {
    const api = new ActionClient({
      endpoint: "https://thwip.example",
      githubApiUrl: "https://api.github.example",
      githubToken: "",
      fetch: vi.fn(),
    });
    await expect(api.github("/repos/example/project")).rejects.toThrow("github-token is required");
  });
});
