import { describe, expect, it, vi } from "vitest";
import {
  githubNameFromOrigin,
  mayWriteGuidance,
  observeInitState,
  readInitRepositoryContext,
  resolveDoctorTarget,
  type InitFetch,
  type InitRepositoryContext,
} from "./init-state.js";

const context: InitRepositoryContext = {
  root: "/repo",
  githubName: "example/project",
  defaultBranch: "trunk",
  baseRef: "refs/heads/trunk",
};

const resolution = { ownerId: "7", repositoryId: "123", projectId: "project_current" };
const ready = {
  ...resolution,
  baseRef: context.baseRef,
  projectEnabled: true,
  activePolicyDigest: `sha256:${"a".repeat(64)}`,
  queueConfigured: true,
  queueEnabled: true,
  activationState: "enforced",
  setupComplete: true,
};

function responses(over: Partial<typeof ready> = {}, repositoryStatus = 200): InitFetch {
  return vi.fn(async (input: string, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user");
    if (input.endsWith("/v1/session/identity")) return Response.json({ githubUserId: "42" });
    if (input.includes("/v1/resolve-repo")) {
      return repositoryStatus === 200
        ? Response.json(resolution)
        : Response.json({ error: "not visible" }, { status: repositoryStatus });
    }
    if (input.includes("/readiness")) return Response.json({ ...ready, ...over });
    throw new Error(`unexpected ${input}`);
  });
}

const observe = (fetch: InitFetch, authHeader: string | null = "Bearer user") =>
  observeInitState({ endpoint: "https://thwip.test", authHeader, githubUserId: "42", context, fetch });

describe("repository context", () => {
  it.each([
    ["https://github.com/example/project.git", "example/project"],
    ["git@github.com:example/project.git", "example/project"],
    ["ssh://git@github.com/example/project", "example/project"],
  ])("parses %s", (remote, expected) => expect(githubNameFromOrigin(remote)).toBe(expected));

  it.each([
    "https://gitlab.com/example/project.git",
    "https://github.com/example/project/extra",
    "https://github.com/example/project`bad",
    "file:///tmp/repo",
  ])("refuses ambiguous origin %s", (remote) => expect(githubNameFromOrigin(remote)).toBeNull());

  it("resolves a nested cwd and the fresh remote default, not a PR target", async () => {
    const run = vi.fn(async (args: readonly string[], cwd: string) => {
      if (args[0] === "rev-parse") return "/repo";
      expect(cwd).toBe("/repo");
      if (args[0] === "config") return "git@github.com:example/project.git";
      if (args[0] === "ls-remote") return "ref: refs/heads/trunk\tHEAD\nabc\tHEAD";
      throw new Error("unexpected git read");
    });
    await expect(readInitRepositoryContext("/repo/packages/app", run)).resolves.toEqual(context);
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain("pr");
  });

  it("fills an omitted doctor target from the repository context", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "config") return "git@github.com:example/project.git";
      if (args[0] === "ls-remote") return "ref: refs/heads/trunk\tHEAD\nabc\tHEAD";
      throw new Error("unexpected git read");
    });

    await expect(resolveDoctorTarget("/repo", run, {})).resolves.toEqual({
      repo: "example/project",
      branch: "trunk",
    });
  });

  it("does not inspect Git when doctor receives both target fields", async () => {
    const run = vi.fn(async () => "");
    await expect(
      resolveDoctorTarget("/not-a-repository", run, { repo: "example/other", branch: "stable" }),
    ).resolves.toEqual({ repo: "example/other", branch: "stable" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("fail-closed live state", () => {
  it("does no request while signed out", async () => {
    const fetch = vi.fn<InitFetch>();
    await expect(observe(fetch, null)).resolves.toMatchObject({ kind: "signed-out" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds the session to the local GitHub identity before repository reads", async () => {
    const fetch: InitFetch = vi.fn(async (input: string) =>
      input.endsWith("/v1/session/identity")
        ? Response.json({ githubUserId: "someone-else" })
        : Response.json(resolution),
    );
    await expect(observe(fetch)).resolves.toMatchObject({ kind: "unreadable", detail: expect.stringContaining("different users") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats 404 as not visible, never as permission to enrol", async () => {
    const state = await observe(responses({}, 404));
    expect(state).toMatchObject({ kind: "not-visible", detail: expect.stringContaining("selection, access sync") });
    expect(mayWriteGuidance(state)).toBe(false);
  });

  it.each([401, 403, 409, 500])("does not default repository status %s", async (status) => {
    const state = await observe(responses({}, status));
    expect(state.kind).toBe(status === 401 ? "signed-out" : "unreadable");
    expect(mayWriteGuidance(state)).toBe(false);
  });

  it("does not default a network or malformed response", async () => {
    const network: InitFetch = vi.fn(async () => { throw new Error("offline"); });
    expect((await observe(network)).kind).toBe("unreadable");
    expect((await observe(responses({ repositoryId: "999" }))).kind).toBe("unreadable");
    expect((await observe(responses({ projectId: "stale" }))).kind).toBe("unreadable");
    expect((await observe(responses({ baseRef: "refs/heads/main" }))).kind).toBe("unreadable");
    expect((await observe(responses({ activePolicyDigest: "" }))).kind).toBe("unreadable");
    expect((await observe(responses({ activePolicyDigest: "sha256:not-a-digest" }))).kind).toBe("unreadable");
  });

  it("bounds stalled control-plane reads", async () => {
    const stalled: InitFetch = vi.fn((_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(
      observeInitState({
        endpoint: "https://thwip.test",
        authHeader: "Bearer user",
        githubUserId: "42",
        context,
        fetch: stalled,
        timeoutMs: 1,
      }),
    ).resolves.toMatchObject({ kind: "unreadable" });
  });
});

describe("state classification", () => {
  it("recognizes a selected repository before queue enrolment", async () => {
    const state = await observe(responses({ queueConfigured: false, queueEnabled: false, activationState: null, setupComplete: false }));
    expect(state.kind).toBe("selected");
    expect(mayWriteGuidance(state)).toBe(true);
  });

  it("recognizes exact enforced readiness for an ordinary member", async () => {
    const fetch = responses();
    const state = await observe(fetch);
    expect(state).toMatchObject({ kind: "ready", repositoryId: "123", projectId: "project_current" });
    expect([...vi.mocked(fetch).mock.calls].some(([url]) => String(url).includes("bootstrap"))).toBe(false);
    expect([...vi.mocked(fetch).mock.calls].some(([url]) => String(url).includes("/doctor"))).toBe(false);
  });

  it.each([
    [{ projectEnabled: false }, "the project is disabled"],
    [{ activePolicyDigest: null }, "no policy is active"],
    [{ queueEnabled: false }, "the queue is disabled"],
    [{ activationState: "observe" }, "activation is observe"],
    [{ setupComplete: false }, "queue setup is not complete"],
  ] as const)("reports a known not-ready reason for %j", async (over, reason) => {
    const state = await observe(responses(over));
    expect(state).toMatchObject({ kind: "not-ready", reasons: expect.arrayContaining([reason]) });
    expect(mayWriteGuidance(state)).toBe(true);
  });
});
