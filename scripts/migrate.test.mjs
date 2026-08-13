import { describe, expect, it, vi } from "vitest";

import { applyMigrations, formatMixedPhaseRefusal, migrationPlan } from "./migrate.mjs";

const migrations = [
  { name: "0022_before.sql", order: "before-worker" },
  { name: "0023_after.sql", order: "after-worker" },
  { name: "0023_second_after.sql", order: "after-worker" },
  { name: "0024_before.sql", order: "before-worker" },
];

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, json: async () => body };
}

function dependencies(applied, health = null) {
  const fetchImpl = vi.fn(async (url) => {
    if (url.endsWith("/v1/schema")) return response({ applied });
    if (url.endsWith("/health")) return response(health ?? { buildSha: "abc123def456" });
    throw new Error(`unexpected URL ${url}`);
  });
  return {
    env: "staging",
    database: "thwip-staging-wnam",
    migrations,
    fetchImpl,
    build: () => "abc123def456",
    identity: { wranglerEnv: { CLOUDFLARE_API_TOKEN: "migration-token" } },
    run: vi.fn(),
    log: vi.fn(),
  };
}

describe("planning migration application", () => {
  it("preserves complete filenames even when migration number prefixes collide", () => {
    expect(migrationPlan(migrations, ["0022_before.sql", "0023_after.sql"])).toEqual({
      kind: "mixed",
      before: ["0024_before.sql"],
      after: ["0023_second_after.sql"],
    });
  });

  it("does nothing when every complete filename is already recorded", () => {
    expect(migrationPlan(migrations, migrations.map((migration) => migration.name)).kind).toBe("current");
  });

  it("lists both phases and the safe staged order in a mixed-set refusal", () => {
    const message = formatMixedPhaseRefusal(
      { before: ["0024_before.sql"], after: ["0023_after.sql"] },
      "staging",
    );
    expect(message).toContain("0024_before.sql");
    expect(message).toContain("0023_after.sql");
    expect(message.indexOf("0023_after.sql")).toBeLessThan(message.indexOf("0024_before.sql"));
    expect(message).toContain("after-worker");
    expect(message).toContain("before-worker");
    expect(message).toContain("migrate, then deploy");
    expect(message).toContain("deploy that commit, then migrate");
  });
});

describe("applying a migration plan", () => {
  it("does not invoke Wrangler when the database is current", async () => {
    const deps = dependencies(migrations.map((migration) => migration.name));
    await expect(applyMigrations(deps)).resolves.toMatchObject({ kind: "current" });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("applies a before-worker-only pending set before the deploy", async () => {
    const deps = dependencies(["0022_before.sql", "0023_after.sql", "0023_second_after.sql"]);
    await expect(applyMigrations(deps)).resolves.toMatchObject({ kind: "before-worker" });
    expect(deps.run).toHaveBeenCalledWith(
      "wrangler",
      ["d1", "migrations", "apply", "thwip-staging-wnam", "--env", "staging", "--remote"],
      { env: { CLOUDFLARE_API_TOKEN: "migration-token" } },
    );
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("applies after-worker migrations only when this exact clean build is live", async () => {
    const deps = dependencies(["0022_before.sql", "0024_before.sql"]);
    await expect(applyMigrations(deps)).resolves.toMatchObject({ kind: "after-worker" });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it("refuses an after-worker migration from a dirty checkout", async () => {
    const deps = { ...dependencies(["0022_before.sql", "0024_before.sql"]), build: () => "abc123def456-dirty" };
    await expect(applyMigrations(deps)).rejects.toThrow(/clean checkout/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses when an after-worker migration's Worker is not yet live", async () => {
    const deps = dependencies(["0022_before.sql", "0024_before.sql"], { buildSha: "older1234567" });
    await expect(applyMigrations(deps)).rejects.toThrow(/exact Worker/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses a mixed pending set without touching D1", async () => {
    const deps = dependencies(["0022_before.sql"]);
    await expect(applyMigrations(deps)).rejects.toThrow(/both sides of a Worker deploy/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses an unreadable or malformed live schema without touching D1", async () => {
    const deps = dependencies([]);
    deps.fetchImpl = vi.fn(async () => response({ notApplied: [] }));
    await expect(applyMigrations(deps)).rejects.toThrow(/applied migration filename list/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses an HTTP schema failure without touching D1", async () => {
    const deps = dependencies([]);
    deps.fetchImpl = vi.fn(async () => response({}, { ok: false, status: 503, statusText: "Unavailable" }));
    await expect(applyMigrations(deps)).rejects.toThrow(/503 Unavailable/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses a migration with no declared phase before reading live state", async () => {
    const deps = dependencies([]);
    deps.migrations = [{ name: "0025_silent.sql", order: null }];
    await expect(applyMigrations(deps)).rejects.toThrow(/declare a deploy order/);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses before any live read when no explicit migration identity was preflighted", async () => {
    const deps = dependencies([]);
    deps.identity = null;
    await expect(applyMigrations(deps)).rejects.toThrow(/no explicit D1 migration identity/);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
});
