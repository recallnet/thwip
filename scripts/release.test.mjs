import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PATHS,
  plannedVersion,
  releaseBump,
  releaseCheckout,
  releaseSourceCommit,
} from "./release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const registry = (version = "0.0.0", sourceCommit = null) => ({ version, sourceCommit });
const SHA = "a".repeat(40);

describe("CLI release planning", () => {
  it("accepts only the exact clean canonical main checkout in Actions", () => {
    const facts = (overrides = {}) => ({ headSha: SHA, remoteMainSha: SHA, dirty: false, ...overrides });
    const action = (overrides = {}) => ({
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "recallnet/thwip",
      GITHUB_REPOSITORY_ID: "1315419165",
      GITHUB_SHA: SHA,
      GITHUB_WORKFLOW_REF: "recallnet/thwip/.github/workflows/thwip-release.yml@refs/heads/main",
      ...overrides,
    });
    expect(releaseCheckout(facts(), action())).toBeNull();
    expect(releaseCheckout(facts(), action({ GITHUB_REF: "refs/heads/feature" }))).toMatch(/refs\/heads\/main/);
    expect(releaseCheckout(facts(), action({
      GITHUB_WORKFLOW_REF: "recallnet/thwip/.github/workflows/thwip-release.yml@refs/heads/feature",
    }))).toMatch(/canonical main/);
    expect(releaseCheckout(facts({ dirty: true }), action())).toMatch(/uncommitted/);
    expect(releaseCheckout(facts({ remoteMainSha: "b".repeat(40) }), action())).toMatch(/origin\/main/);
  });

  it("publishes a patch for a plain-language merge title", () => {
    expect(releaseBump({ changed: true, subjects: "Make policy path handling linear", bodies: "" })).toBe("patch");
  });

  it("keeps conventional major and minor signals", () => {
    expect(releaseBump({ changed: true, subjects: "feat(cli): add repair", bodies: "" })).toBe("minor");
    expect(releaseBump({ changed: true, subjects: "fix!: change proof bytes", bodies: "" })).toBe("major");
    expect(releaseBump({ changed: true, subjects: "fix: compatibility", bodies: "BREAKING CHANGE: wire format" })).toBe("major");
  });

  it("does not release when no bundled input changed", () => {
    expect(releaseBump({ changed: false, subjects: "", bodies: "" })).toBe("none");
  });

  it("uses npm's full source commit when the CLI also publishes a short build stamp", () => {
    expect(releaseSourceCommit({
      gitHead: "3e9b358a719a706defd3fc11a223536ef8dc1b4c",
      thwipSourceCommit: "3e9b358a719a",
    })).toBe("3e9b358a719a706defd3fc11a223536ef8dc1b4c");
  });

  it("recovers the same version after npm accepted this exact commit", () => {
    expect(plannedVersion({
      bump: "patch",
      declaredVersion: "0.1.1",
      lastTagVersion: "0.16.2",
      npm: registry("0.16.3", "abc"),
      head: "abc",
    })).toEqual({
      version: "0.16.3",
      recovering: true,
      npmExists: true,
    });
  });

  it("never reuses a version published from another commit", () => {
    expect(plannedVersion({
      bump: "patch",
      declaredVersion: "0.1.1",
      lastTagVersion: "0.16.2",
      npm: registry("0.16.3", "older"),
      head: "newer",
    }).version).toBe("0.16.4");
  });

  it("covers the complete workspace dependency closure for the CLI and Action", () => {
    const names = new Map();
    for (const directory of RELEASE_PATHS.filter((path) => /^packages\/[^/]+$/.test(path))) {
      const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
      names.set(manifest.name, directory);
    }
    const pending = ["@thwip/cli", "@thwip/action"];
    const closure = new Set();
    while (pending.length > 0) {
      const name = pending.pop();
      if (closure.has(name)) continue;
      closure.add(name);
      const directory = names.get(name);
      expect(directory, `${name} is missing from RELEASE_PATHS`).toBeDefined();
      const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
      for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
        if (String(range).startsWith("workspace:")) pending.push(dependency);
      }
    }
    expect([...closure].sort()).toEqual([...names.keys()].sort());
  });

  it("keeps every release input in the workflow trigger", () => {
    const workflow = readFileSync(join(root, ".github/workflows/thwip-release.yml"), "utf8");
    for (const path of RELEASE_PATHS) {
      const trigger = path.includes(".") ? path : `${path}/**`;
      expect(workflow).toContain(`- "${trigger}"`);
    }
    expect(workflow).toContain("run: git diff --exit-code");
    expect(workflow).toContain('confirm_install "npm"');
    expect(workflow).toContain('echo "@recallnet:registry=https://registry.npmjs.org"');
    expect(workflow).toContain('(cd "$probe" && npm install');
    expect(workflow).toContain('--cache="$probe/.npm-cache"');
    expect(workflow).toContain('--prefer-online');
    expect(workflow).toContain('(cd "$probe" && ./node_modules/.bin/thwip version)');
    expect(workflow).toContain('max_attempts=18');
  });

  it("uses one release entry for planning, packaging, and build stamps", () => {
    const source = readFileSync(join(root, "scripts/release.mjs"), "utf8");
    expect(source).toContain("THWIP_RELEASE_VERSION");
    expect(source).toContain('command === "plan"');
    expect(source).toContain('command === "package"');
    expect(source).toContain('command === "stamp"');
    expect(source).not.toMatch(/^import .* from ["']esbuild["'];$/m);
    expect(source).toContain('await import("esbuild")');
  });

  it("does not rewrite a tracked file to carry the version", () => {
    const workflow = readFileSync(join(root, ".github/workflows/thwip-release.yml"), "utf8");
    expect(workflow).not.toContain("packages/cli/package.json > /tmp/pkg.json");
    expect(workflow).toContain("THWIP_RELEASE_VERSION");
  });

  it("ships the GitHub Action as a committed bundle, not a consumer build", () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    const main = /^\s*main:\s*(\S+)\s*$/m.exec(action)?.[1];
    expect(main).toBe("packages/action/dist/index.cjs");
    expect(existsSync(join(root, main))).toBe(true);
  });
});
