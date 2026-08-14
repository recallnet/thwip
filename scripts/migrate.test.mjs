import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  applySelectedMigrationFiles,
  migrationPlan,
  selectedMigrationConfig,
} from "./control-plane.mjs";
import {
  blockingMigrations,
  formatSchemaRefusal,
  liveMigrationState,
  migrationFileTrack,
  migrationTrackRefusal,
  missingMigrationFiles,
  readMigrations,
  unappliedAgainst,
  undeclaredMigrations,
} from "./migration-core.mjs";
import { MIGRATION_RELEASES } from "../packages/migration-plan/src/index.mjs";

const SHA = "a".repeat(40);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const migrations = [
  { name: "0022_before.sql", phase: "before-worker" },
  { name: "0023_after.sql", phase: "after-worker", barrier: "after" },
  { name: "0023_second_after.sql", phase: "after-worker", barrier: "after" },
  { name: "0024_before.sql", phase: "before-worker" },
];

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return { ok, status, statusText, json: async () => body };
}

function dependencies(applied, health = null, track = "legacy") {
  const fetchImpl = vi.fn(async (url) => {
    if (url.endsWith("/v1/schema")) return response({ applied, schema: { track } });
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

  it("resolves the pinned Wrangler binary while the migration config is in a temporary directory", () => {
    const fixture = mkdtempSync(join(tmpdir(), "thwip-migration-command-"));
    try {
      const migrationsDir = join(fixture, "source");
      mkdirSync(migrationsDir);
      writeFileSync(join(migrationsDir, "0001_fixture.sql"), "SELECT 1;\n");
      const configPath = join(fixture, "wrangler.jsonc");
      writeFileSync(configPath, JSON.stringify({
        compatibility_date: "2026-07-01",
        env: {
          staging: {
            d1_databases: [{
              binding: "DB",
              database_name: "thwip-staging-wnam",
              database_id: "db-id",
            }],
          },
        },
      }));

      let invoked = false;
      applySelectedMigrationFiles({
        names: ["0001_fixture.sql"],
        env: "staging",
        database: "thwip-staging-wnam",
        migrationsDir,
        configPath,
        wranglerEnv: process.env,
        workspaceRoot: ROOT,
        execute: (program, args, options) => {
          invoked = true;
          expect(program).toBe("pnpm");
          expect(existsSync(join(options.cwd, "package.json"))).toBe(false);
          expect(args.slice(0, 4)).toEqual(["--dir", ROOT, "--filter", "@thwip/control-plane"]);
          const config = args[args.indexOf("--config") + 1];
          expect(existsSync(config)).toBe(true);
          const wrangler = args.indexOf("wrangler");
          expect(execFileSync(program, [...args.slice(0, wrangler + 1), "--version"], {
            cwd: options.cwd,
            encoding: "utf8",
          })).toMatch(/^\d+\.\d+\.\d+\s*$/);
        },
      });
      expect(invoked).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
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

  it("refuses the lifecycle finishing migration before the one-hour compatibility window", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
        projectLifecycle: {
        maintenanceMode: false,
        workerActivatedAt: new Date().toISOString(),
        backfillReady: true,
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
    });
    deps.migrations = lifecycleMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/served for at least one hour/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("applies the lifecycle finishing migration in place after the Worker window and backfill", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
      projectLifecycle: {
        maintenanceMode: false,
        workerActivatedAt: "2026-08-12T10:00:00.000Z",
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

  it("refuses the finishing migration if maintenance is already active", async () => {
    const deps = dependencies(["0030_github_repository_lifecycle.sql"], {
      buildSha: SHA,
      projectLifecycle: {
        maintenanceMode: true,
        workerActivatedAt: "2026-08-12T10:00:00.000Z",
        backfillReady: true,
        destructiveSchemaReadyAt: null,
        cleanupReady: false,
      },
    });
    deps.migrations = lifecycleMigrations;
    await expect(applyMigrations(deps)).rejects.toThrow(/maintenanceMode=false/);
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
    ["incomplete cleanup readiness", { projectLifecycle: { ...reopenHealth().projectLifecycle, cleanupReady: false } }],
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

  it("refuses a missing or different durable starting track before running Wrangler", async () => {
    const missing = dependencies([]);
    missing.fetchImpl = vi.fn(async () => response({ applied: [] }));
    await expect(applyMigrations(missing)).rejects.toThrow(/supported migration track/);
    expect(missing.run).not.toHaveBeenCalled();

    const baseline = [{ name: "1000_current_schema.sql", phase: "before-worker" }];
    expect(migrationFileTrack(baseline)).toBe("baseline");
    expect(migrationTrackRefusal(baseline, "legacy")).toMatch(/legacy.*baseline/);
    const legacyDatabase = dependencies([], null, "legacy");
    legacyDatabase.migrations = baseline;
    await expect(applyMigrations(legacyDatabase)).rejects.toThrow(/legacy migration track.*baseline track/);
    expect(legacyDatabase.run).not.toHaveBeenCalled();

    const baselineDatabase = dependencies([], null, "baseline");
    await expect(applyMigrations(baselineDatabase)).rejects.toThrow(/baseline migration track.*legacy track/);
    expect(baselineDatabase.run).not.toHaveBeenCalled();
  });

  it("reads the track from the Worker's real public schema envelope", () => {
    expect(liveMigrationState({
      applied: ["1000_current_schema.sql"],
      schema: { track: "baseline", phase: "current" },
      buildSha: SHA,
    })).toEqual({ applied: ["1000_current_schema.sql"], track: "baseline" });
    expect(liveMigrationState({ schema: { track: "legacy" } })).toBeNull();
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

describe("the shared migration release model", () => {
  const directory = fileURLToPath(new URL("../migrations", import.meta.url));
  const baselineDirectory = fileURLToPath(new URL("../migrations-baseline", import.meta.url));
  const real = readMigrations(directory);
  const namesThrough = (last) => MIGRATION_RELEASES
    .map(({ name }) => name)
    .filter((name) => name <= last);

  it("declares every SQL file and preserves the exceptional deploy phases", () => {
    expect(real.length).toBeGreaterThan(20);
    expect(undeclaredMigrations(real)).toEqual([]);
    expect(missingMigrationFiles(real)).toEqual([]);
    const phases = new Map(real.map(({ name, phase }) => [name, phase]));
    expect(phases.get("0018_one_record_per_merge.sql")).toBe("after-worker");
    expect(phases.get("0020_queue_runners.sql")).toBe("before-worker");
    expect(phases.get("0033_verifier_protocol_v3.sql")).toBe("before-worker");
  });

  it("accepts the public baseline as a complete alternative starting track", () => {
    const baseline = readMigrations(baselineDirectory);
    expect(baseline).toEqual([{ name: "1000_current_schema.sql", phase: "before-worker" }]);
    expect(undeclaredMigrations(baseline)).toEqual([]);
    expect(missingMigrationFiles(baseline)).toEqual([]);
    expect(migrationPlan(baseline, [])).toMatchObject({
      kind: "before-worker",
      selected: ["1000_current_schema.sql"],
      deployBlockers: ["1000_current_schema.sql"],
    });
    expect(migrationPlan(baseline, ["1000_current_schema.sql"])).toMatchObject({
      kind: "current",
      selected: [],
    });
  });

  it("refuses a migration directory that mixes both starting tracks", () => {
    const directory = mkdtempSync(join(tmpdir(), "thwip-mixed-migrations-"));
    try {
      writeFileSync(join(directory, "0001_init.sql"), "SELECT 1;\n");
      writeFileSync(join(directory, "1000_current_schema.sql"), "SELECT 1;\n");
      expect(undeclaredMigrations(readMigrations(directory))).toEqual(["1000_current_schema.sql"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows only the two applied historical migration-number collisions", () => {
    const groups = new Map();
    for (const { name } of real) {
      const number = /^\d+/.exec(name)?.[0];
      const names = groups.get(number) ?? [];
      names.push(name);
      groups.set(number, names);
    }
    expect([...groups.entries()].filter(([, names]) => names.length > 1)).toEqual([
      ["0008", ["0008_policy_activation_source.sql", "0008_queue_projection_serves_reads.sql"]],
      ["0023", ["0023_remove_queue_runtime_selectors.sql", "0023_status_comment_per_pull_request.sql"]],
    ]);
  });

  it.each([
    ["0028_project_removal.sql", "before-worker", ["0029_terminal_comment_priority.sql", "0030_github_repository_lifecycle.sql"]],
    ["0030_github_repository_lifecycle.sql", "after-worker", ["0031_finish_github_repository_lifecycle.sql"]],
    ["0031_finish_github_repository_lifecycle.sql", "before-worker", ["0032_private_agent_feedback_foundation.sql", "0033_verifier_protocol_v3.sql"]],
    ["0033_verifier_protocol_v3.sql", "after-worker", ["0034_reopen_after_project_lifecycle.sql"]],
    ["0034_reopen_after_project_lifecycle.sql", "current", []],
  ])("moves safely from %s", (last, kind, selected) => {
    expect(migrationPlan(MIGRATION_RELEASES, namesThrough(last))).toMatchObject({ kind, selected });
  });

  it("refuses a ledger that skipped a known barrier", () => {
    const applied = namesThrough("0030_github_repository_lifecycle.sql").concat(
      "0032_private_agent_feedback_foundation.sql",
      "0033_verifier_protocol_v3.sql",
    );
    expect(migrationPlan(MIGRATION_RELEASES, applied).outOfOrderApplied).toEqual([
      "0032_private_agent_feedback_foundation.sql",
      "0033_verifier_protocol_v3.sql",
    ]);
  });

  it("blocks only migrations that the current Worker needs", () => {
    const sample = [
      { name: "0001.sql", phase: "before-worker" },
      { name: "0002.sql", phase: "after-worker", barrier: "second" },
      { name: "0003.sql", phase: "before-worker" },
    ];
    expect(blockingMigrations(sample, ["0003.sql"])).toEqual(["0003.sql"]);
    expect(blockingMigrations(sample, ["0002.sql"])).toEqual([]);
    expect(unappliedAgainst(sample, ["0001.sql", "0099.sql"])).toEqual(["0002.sql", "0003.sql"]);
    const refusal = formatSchemaRefusal(["0003.sql"], "staging", "thwip.ai");
    expect(refusal).toContain("run migrate:staging -- --confirm-live thwip.ai");
    expect(refusal).not.toContain("wrangler d1");
  });
});
