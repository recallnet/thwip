import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PATHS,
  plannedVersion,
  releaseBump,
} from "./plan-cli-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const registry = (version = "0.0.0", sourceCommit = null) => ({ version, sourceCommit });

describe("CLI release planning", () => {
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

  it("recovers the same version after only one registry accepted this exact commit", () => {
    expect(plannedVersion({
      bump: "patch",
      declaredVersion: "0.1.1",
      lastTagVersion: "0.16.2",
      npm: registry("0.16.3", "abc"),
      github: registry(),
      head: "abc",
    })).toEqual({
      version: "0.16.3",
      recovering: true,
      npmExists: true,
      githubExists: false,
    });
  });

  it("never reuses a version published from another commit", () => {
    expect(plannedVersion({
      bump: "patch",
      declaredVersion: "0.1.1",
      lastTagVersion: "0.16.2",
      npm: registry("0.16.3", "older"),
      github: registry("0.16.3", "older"),
      head: "newer",
    }).version).toBe("0.16.4");
  });

  it("refuses conflicting bytes at the version it would recover", () => {
    expect(() => plannedVersion({
      bump: "patch",
      declaredVersion: "0.1.1",
      lastTagVersion: "0.16.2",
      npm: registry("0.16.3", "abc"),
      github: registry("0.16.3", "different"),
      head: "abc",
    })).toThrow(/GitHub Packages already contains/);
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
    expect(workflow).toContain('confirm_install "GitHub Packages"');
    expect(workflow).toContain('(cd "$probe" && ./node_modules/.bin/thwip version)');
  });

  it("ships the GitHub Action as a committed bundle, not a consumer build", () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    const main = /^\s*main:\s*(\S+)\s*$/m.exec(action)?.[1];
    expect(main).toBe("packages/action/dist/index.cjs");
    expect(existsSync(join(root, main))).toBe(true);
  });
});
