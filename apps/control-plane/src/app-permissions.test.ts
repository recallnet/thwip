import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_MANIFEST_PERMISSIONS, REQUIRED_APP_PERMISSIONS } from "./app-permissions.js";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/**
 * The manifest asked for less than the doctor in the same file demands.
 *
 * `queueDoctor` reports capabilities from the same permissions the manifest
 * requests. A fresh installation has to publish checks and perform its merges.
 * A repository administrator owns ruleset changes because GitHub offers no
 * narrow App permission for that operation.
 */
describe("what the App asks for against what it needs", () => {
  it("requests every permission the doctor requires", () => {
    for (const [scope, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
      expect(APP_MANIFEST_PERMISSIONS[scope]).toBe(level);
    }
  });

  /**
   * Writing an ordinary merge commit and moving the branch ref are Contents.
   * GitHub additionally requires Workflows when that exact commit changes an
   * Actions definition; the sole writer must be able to land both shapes.
   */
  it("asks for the write on contents the merge needs", () => {
    expect(REQUIRED_APP_PERMISSIONS["contents"]).toBe("write");
    expect(REQUIRED_APP_PERMISSIONS["pull_requests"]).toBe("write");
    expect(REQUIRED_APP_PERMISSIONS["workflows"]).toBe("write");
  });

  it("gives only the App, not candidate jobs, the Actions read used by the trusted finalizer", () => {
    expect(REQUIRED_APP_PERMISSIONS["actions"]).toBe("read");
    expect(source("queue/bootstrap-workflows.ts")).not.toMatch(/verify:[\s\S]{0,500}actions:\s*read/);
  });

  /** `pull_requests: write` is sufficient for pull-request conversations. */
  it("does not demand a scope the App comments without", () => {
    expect(REQUIRED_APP_PERMISSIONS["issues"]).toBeUndefined();
    expect(APP_MANIFEST_PERMISSIONS["issues"]).toBeUndefined();
  });

  it("does not ask the runtime App for repository administration", () => {
    expect(REQUIRED_APP_PERMISSIONS["administration"]).toBeUndefined();
    expect(APP_MANIFEST_PERMISSIONS["administration"]).toBeUndefined();
  });

  it("widens nothing beyond what the doctor requires", () => {
    const extra = Object.entries(APP_MANIFEST_PERMISSIONS).filter(
      ([scope, level]) => REQUIRED_APP_PERMISSIONS[scope] !== level,
    );
    expect(extra.every(([, level]) => level === "read")).toBe(true);
  });

  it("is read from the constant rather than typed into the manifest again", () => {
    expect(source("index.ts")).toContain("default_permissions: APP_MANIFEST_PERMISSIONS");
    expect(source("index.ts")).not.toMatch(/default_permissions:\s*\{/);
    expect(source("index.ts")).toContain("requiredPermissions: REQUIRED_APP_PERMISSIONS");
    expect(source("index.ts")).toContain('scope !== "workflows"');
    expect(source("index.ts")).toContain("canConfigureRulesets");
    expect(source("index.ts")).toContain("canInspectRulesets");
  });

  /**
   * An installation predating the permission keeps merging and stops
   * commenting, so the doctor has to name that one consequence rather than
   * leaving an operator to read a scope name and infer it.
   */
  it("reports whether the App may write the status comment", () => {
    expect(source("index.ts")).toContain("canComment:");
  });
});
