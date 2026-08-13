import { describe, expect, it, vi } from "vitest";

import { applyMigrations, migrationPlan, selectedMigrationConfig } from "./migrate.mjs";

const SHA = "a".repeat(40);

const migrations = [
  { name: "0022_before.sql", phase: "before-worker" },
  { name: "0023_after.sql", phase: "after-worker", barrier: "after" },
  { name: "0023_second_after.sql", phase: "after-worker", barrier: "after" },
  { name: "0024_before.sql", phase: "before-worker" },
];

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, json: async () => body };
}

function dependencies(applied, health = null) {
  const fetchImpl = vi.fn(async (url) => {
    if (url.endsWith("/v1/schema")) return response({ applied });
    if (url.endsWith("/health")) return response(health ?? { buildSha: SHA });
    throw new Error(`unexpected URL ${url}`);
  });
  return {
    env: "staging",
    database: "thwip-staging-wnam",
    migrations,
    fetchImpl,
    build: () => SHA,
    canonicalBuild: () => SHA,
    identity: { wranglerEnv: { CLOUDFLARE_API_TOKEN: "migration-token" } },
    run: vi.fn(),
    log: vi.fn(),
  };
}

const lifecycleMigrations = [
  { name: "0030_github_repository_lifecycle.sql", phase: "before-worker" },
  { name: "0031_finish_github_repository_lifecycle.sql", phase: "after-worker", barrier: "lifecycle" },
];

const reopenMigrations = [
  { name: "0031_finish_github_repository_lifecycle.sql", phase: "after-worker", barrier: "lifecycle" },
  { name: "0032_private_agent_feedback_foundation.sql", phase: "before-worker" },
  { name: "0033_verifier_protocol_v3.sql", phase: "before-worker" },
  { name: "0034_reopen_after_project_lifecycle.sql", phase: "after-worker", barrier: "reopen" },
];

function reopenHealth(overrides = {}) {
  return {
    buildSha: SHA,
    schema: {
      phase: "after-worker",
      selected: ["0034_reopen_after_project_lifecycle.sql"],
      capabilities: {
        lifecycleFinished: true,
        privateAgentFeedback: true,
        verifierProtocolV3: true,
      },
    },
    projectLifecycle: {
      workerBuildSha: SHA,
      workerDeploymentId: "00000000-0000-4000-8000-000000000002",
      verifierV3PredeployId: "00000000-0000-4000-8000-000000000001",
      remoteCapabilitiesRetiredAt: "2026-08-12T11:00:00.000Z",
      remoteCapabilityEvidenceComplete: true,
      maintenanceMode: true,
      backfillReady: true,
      destructiveSchemaReadyAt: "2026-08-12T12:00:00.000Z",
      cleanupReady: true,
    },
    ...overrides,
  };
}

describe("planning migration application", () => {
  it("preserves complete filenames even when migration number prefixes collide", () => {
    expect(migrationPlan(migrations, ["0022_before.sql", "0023_after.sql"])).toMatchObject({
      after: ["0023_second_after.sql"],
      before: [],
      deferred: ["0024_before.sql"],
      kind: "after-worker",
    });
  });

  it("does nothing when every complete filename is already recorded", () => {
    expect(migrationPlan(migrations, migrations.map((migration) => migration.name)).kind).toBe("current");
  });

  it("selects only the first contiguous phase from a mixed pending tree", () => {
    expect(migrationPlan(migrations, ["0022_before.sql"])).toMatchObject({
      kind: "after-worker",
      before: [],
      after: ["0023_after.sql", "0023_second_after.sql"],
      deferred: ["0024_before.sql"],
    });
  });
});

describe("the phase-only Wrangler configuration", () => {
  it("preserves the exact remote database while changing only the visible migration directory", () => {
    const config = selectedMigrationConfig(
      JSON.stringify({
        compatibility_date: "2026-07-01",
        env: {
          staging: {
            d1_databases: [{ binding: "DB", database_name: "thwip-staging-wnam", database_id: "db-id", migrations_dir: "all" }],
          },
        },
      }),
      "staging",
      "thwip-staging-wnam",
    );
    expect(config.env.staging.d1_databases).toEqual([
      { binding: "DB", database_name: "thwip-staging-wnam", database_id: "db-id", migrations_dir: "migrations" },
    ]);
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
    expect(deps.run).toHaveBeenCalledWith(["0024_before.sql"]);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a before-worker batch from a dirty or non-canonical checkout", async () => {
    const dirty = { ...dependencies([]), build: () => `${SHA}-dirty` };
    await expect(applyMigrations(dirty)).rejects.toThrow(/clean checkout/);
    expect(dirty.run).not.toHaveBeenCalled();

    const old = "b".repeat(40);
    const stale = { ...dependencies([]), build: () => old, canonicalBuild: () => SHA };
    await expect(applyMigrations(stale)).rejects.toThrow(/current canonical main/);
    expect(stale.run).not.toHaveBeenCalled();
  });

  it("applies after-worker migrations only when this exact clean build is live", async () => {
    const deps = dependencies(["0022_before.sql"]);
    await expect(applyMigrations(deps)).resolves.toMatchObject({ kind: "after-worker" });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it("refuses an after-worker migration from a dirty checkout", async () => {
    const deps = { ...dependencies(["0022_before.sql"]), build: () => `${SHA}-dirty` };
    await expect(applyMigrations(deps)).rejects.toThrow(/clean checkout/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses when an after-worker migration's Worker is not yet live", async () => {
    const deps = dependencies(["0022_before.sql"], { buildSha: "b".repeat(40) });
    await expect(applyMigrations(deps)).rejects.toThrow(/exact Worker/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses an old checkout even when the live Worker serves that same old SHA", async () => {
    const old = "b".repeat(40);
    const deps = {
      ...dependencies(["0022_before.sql"], { buildSha: old }),
      build: () => old,
      canonicalBuild: () => SHA,
    };
    await expect(applyMigrations(deps)).rejects.toThrow(/current canonical main/);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses the lifecycle finishing migration until remote capabilities are explicitly retired", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
        projectLifecycle: {
        maintenanceMode: false,
        workerActivatedAt: "2026-08-12T10:00:00.000Z",
        remoteCapabilitiesRetiredAt: null,
        remoteCapabilityEvidenceComplete: false,
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
    });
    deps.migrations = lifecycleMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/remote capability cutover has not been recorded/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("applies the lifecycle finishing migration after the exact Worker and capability cutover are confirmed", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
      projectLifecycle: {
        maintenanceMode: true,
        workerActivatedAt: "2026-08-12T10:00:00.000Z",
        remoteCapabilitiesRetiredAt: "2026-08-12T11:00:00.000Z",
        remoteCapabilityEvidenceComplete: true,
        backfillReady: true,
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
    });
    deps.migrations = lifecycleMigrations;
    await expect(applyMigrations(deps)).resolves.toMatchObject({
      kind: "after-worker",
      after: ["0031_finish_github_repository_lifecycle.sql"],
    });
    expect(deps.run).toHaveBeenCalledWith(["0031_finish_github_repository_lifecycle.sql"]);
  });

  it("refuses the finishing migration while the new D1 generation is not fenced", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
      projectLifecycle: {
        maintenanceMode: false,
        workerActivatedAt: "2026-08-12T10:00:00.000Z",
        remoteCapabilitiesRetiredAt: "2026-08-12T11:00:00.000Z",
        remoteCapabilityEvidenceComplete: true,
        backfillReady: true,
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
    });
    deps.migrations = lifecycleMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/maintenanceMode=true/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("applies only the first phase of a mixed pending set", async () => {
    const deps = dependencies(["0022_before.sql"]);
    await expect(applyMigrations(deps)).resolves.toMatchObject({
      kind: "after-worker",
      after: ["0023_after.sql", "0023_second_after.sql"],
      deferred: ["0024_before.sql"],
    });
    expect(deps.run).toHaveBeenCalledWith(["0023_after.sql", "0023_second_after.sql"]);
  });

  it("applies 0034 only after the exact compatible Worker proves the fenced schema is ready", async () => {
    const deps = dependencies(reopenMigrations.slice(0, 3).map((migration) => migration.name), reopenHealth());
    deps.migrations = reopenMigrations;
    await expect(applyMigrations(deps)).resolves.toMatchObject({
      kind: "after-worker",
      after: ["0034_reopen_after_project_lifecycle.sql"],
    });
    expect(deps.run).toHaveBeenCalledWith(["0034_reopen_after_project_lifecycle.sql"]);
  });

  it.each([
    ["a different serving Worker", { projectLifecycle: { ...reopenHealth().projectLifecycle, workerBuildSha: "older" } }],
    ["a missing schema capability", {
      schema: {
        ...reopenHealth().schema,
        capabilities: { ...reopenHealth().schema.capabilities, verifierProtocolV3: false },
      },
    }],
    ["the wrong selected phase", { schema: { ...reopenHealth().schema, selected: [] } }],
    ["an open traffic fence", { projectLifecycle: { ...reopenHealth().projectLifecycle, maintenanceMode: false } }],
    ["incomplete cleanup evidence", { projectLifecycle: { ...reopenHealth().projectLifecycle, cleanupReady: false } }],
  ])("refuses 0034 for %s", async (_reason, overrides) => {
    const deps = dependencies(
      reopenMigrations.slice(0, 3).map((migration) => migration.name),
      reopenHealth(overrides),
    );
    deps.migrations = reopenMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/not ready to reopen traffic/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses an out-of-order known migration ledger before asking health or running Wrangler", async () => {
    const deps = dependencies(["0031_finish_github_repository_lifecycle.sql", "0033_verifier_protocol_v3.sql"]);
    deps.migrations = reopenMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/not a valid prefix/);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
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
    deps.migrations = [{ name: "0025_silent.sql", phase: null }];
    await expect(applyMigrations(deps)).rejects.toThrow(/absent from the shared release model/);
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
