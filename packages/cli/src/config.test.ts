import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectConfigAtHead, loadProjectConfigForRun } from "./config.js";

const exec = promisify(execFile);
const directories: string[] = [];

async function repository(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "thwip-config-"));
  directories.push(cwd);
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  await exec("git", ["config", "thwip.owner-id", "10"], { cwd });
  await exec("git", ["config", "thwip.repository-id", "20"], { cwd });
  for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-qm", "fixture"], { cwd });
  return cwd;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("effective CLI configuration", () => {
  it("runs an edited policy under the active base configuration", async () => {
    const cwd = await repository({
      "thwip.yaml": "version: 1\nprofile: fast\nrequired: [test]\nsuites:\n  test: npm test\n",
    });
    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    await writeFile(
      join(cwd, "thwip.yaml"),
      "version: 2\nprofile: fast\nrequired: [lint]\nsuites:\n  lint: npm run lint\n",
    );
    await exec("git", ["add", "thwip.yaml"], { cwd });
    await exec("git", ["commit", "-qm", "edit policy"], { cwd });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ defaults: null, activePolicySourceSha: baseSha }),
      ),
    );

    const config = await loadProjectConfigForRun(cwd, "https://thwip.example", "Bearer token");

    expect(config.policy.version).toBe(1);
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("uses the candidate configuration while bootstrapping the first policy", async () => {
    const cwd = await repository({
      "thwip.yaml": "version: 4\nprofile: fast\nrequired: [test]\nsuites:\n  test: npm test\n",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ defaults: null, activePolicySourceSha: null })),
    );

    const config = await loadProjectConfigForRun(cwd, "https://thwip.example", "Bearer token");

    expect(config.policy.version).toBe(4);
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("loads organization defaults for a repository with no thwip.yaml", async () => {
    const cwd = await repository({ "package-lock.json": "{}" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          defaults: {
            version: 1,
            profile: "fast",
            required: ["test"],
            suites: { test: "npm test" },
          },
        }),
      ),
    );

    const config = await loadProjectConfigAtHead(cwd, "https://thwip.example", "Bearer token");

    expect(config.configSource).toBe("global");
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("applies repository fields over organization defaults", async () => {
    const cwd = await repository({
      "package-lock.json": "{}",
      "thwip.yaml": "version: 2\nprofile: remote\nrequired: [test]\npolicy:\n  allow_author_as_signer: false\n",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          defaults: {
            version: 1,
            profile: "fast",
            required: ["lint"],
            suites: { lint: "npm run lint", test: "npm test" },
            policy: { minimum_permission: "maintain", allow_author_as_signer: true },
          },
        }),
      ),
    );

    const config = await loadProjectConfigAtHead(cwd, "https://thwip.example", "Bearer token");

    expect(config.configSource).toBe("repository-override");
    expect(config.policy).toMatchObject({
      version: 2,
      securityProfile: "remote",
      minimumPermission: "maintain",
      allowAuthorAsSigner: false,
      pipeline: { requiredSuites: ["test"] },
    });
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("uses a complete repository configuration during a rolling server upgrade", async () => {
    const cwd = await repository({
      "package-lock.json": "{}",
      "thwip.yaml": "version: 1\nprofile: fast\nrequired: [test]\nsuites:\n  test: npm test\n",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not deployed", { status: 404 })));

    const config = await loadProjectConfigAtHead(cwd, "https://thwip.example", "Bearer token");

    expect(config.configSource).toBe("repository-override");
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("ignores the legacy dashboard fallback for the not-yet-deployed defaults route", async () => {
    const cwd = await repository({
      "package-lock.json": "{}",
      "thwip.yaml": "version: 1\nprofile: fast\nrequired: [test]\nsuites:\n  test: npm test\n",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })),
    );

    const config = await loadProjectConfigAtHead(cwd, "https://thwip.example", "Bearer token");

    expect(config.configSource).toBe("repository-override");
    expect(config.pipeline.suites).toEqual([{ id: "test", command: ["sh", "-c", "npm test"] }]);
  });

  it("fails clearly when neither source is configured", async () => {
    const cwd = await repository({ "package-lock.json": "{}" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ defaults: null })));

    await expect(loadProjectConfigAtHead(cwd, "https://thwip.example", "Bearer token")).rejects.toThrow(
      "no thwip.yaml or organization defaults",
    );
  });
});
