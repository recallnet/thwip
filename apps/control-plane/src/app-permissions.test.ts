import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_MANIFEST_PERMISSIONS, REQUIRED_APP_PERMISSIONS } from "./app-permissions.js";

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/**
 * The manifest asked for less than the doctor in the same file demands.
 *
 * `queueDoctor` reports `canMerge` off `contents` and `pull_requests` being
 * write, and the manifest requested both as read and left `statuses` out
 * altogether. An App registered from that manifest fails the diagnostic written
 * beside it. Nobody found out, because a manifest describes a fresh
 * registration and the installed App was granted its permissions by hand.
 */
describe("what the App asks for against what it needs", () => {
  it("requests every permission the doctor requires", () => {
    for (const [scope, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
      expect(APP_MANIFEST_PERMISSIONS[scope]).toBe(level);
    }
  });

  /**
   * Writing the merge commit and moving the branch ref are both Contents, and
   * the ownership ruleset already names the App as the only actor that may
   * update a managed branch.
   */
  it("asks for the write on contents the merge needs", () => {
    expect(REQUIRED_APP_PERMISSIONS["contents"]).toBe("write");
    expect(REQUIRED_APP_PERMISSIONS["pull_requests"]).toBe("write");
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
  });
});
