import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  breakGlassRefusal,
  buildStamp,
  d1CredentialFromEnv,
  deployCheckout,
  deployIdentity,
  deploymentId,
  dirtyShaCaveat,
  exceptionStamp,
  excuses,
  liveD1Target,
  liveSchemaUrl,
  liveTargetRefusal,
  parseBreakGlass,
  preflightD1Credential,
  preflightDeploy,
  preflightDeployCredential,
  tokenAcceptance,
  validDeploymentId,
  verifyD1CredentialCleared,
  waitForBuildSha,
  wranglerEnvironment,
} from "./control-plane-core.mjs";
import { commandFor, executeRead, invokedAsMain, readDiagnostic, refuse } from "./control-plane.mjs";
import { readMigrations } from "./migration-core.mjs";

const SHA = "a".repeat(40);
const ACCOUNT = "a".repeat(32);
const TARGET = liveD1Target("staging");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REASON = "the queue cannot merge its own repair, so the fix cannot reach main";
const response = (body, status = 200, statusText = "OK") => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
});
const verified = (expiresOn = "2026-08-13T00:00:00Z") => response({
  success: true,
  result: { status: "active", expires_on: expiresOn },
});
const d1Probe = () => response({
  success: true,
  result: [{ success: true, results: [{ thwip_d1_preflight: 1 }], meta: { changed_db: false, rows_written: 0 } }],
});
const clock = () => {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
};

describe("break-glass declarations", () => {
  it("excuses only named guards and requires a useful reason", () => {
    const declared = parseBreakGlass(`unmerged-tree: ${REASON}`);
    expect(excuses(declared, "unmerged-tree")).toBe(true);
    expect(excuses(declared, "pending-migrations")).toBe(false);
    expect(parseBreakGlass("unmerged-tree: urgent").error).toContain("reason");
    expect(parseBreakGlass(`unknown: ${REASON}`).error).toContain("unknown");
  });

  it("records the exact exception and teaches the scoped command", () => {
    const declared = parseBreakGlass(`unmerged-tree: ${REASON}`);
    expect(JSON.parse(exceptionStamp(declared, { branch: "repair", head: "abc", at: "now" })))
      .toEqual({ guards: ["unmerged-tree"], reason: REASON, tree: "repair@abc", at: "now" });
    expect(exceptionStamp(parseBreakGlass(), { branch: "main", head: "abc", at: "now" })).toBe("");
    expect(breakGlassRefusal("unmerged-tree", "use main")).toContain('THWIP_BREAK_GLASS="unmerged-tree: ');
    expect(breakGlassRefusal("unmerged-tree", "use main"))
      .toContain("pnpm --filter @thwip/control-plane run deploy:staging");
  });
});

describe("deploy identity", () => {
  const facts = (over = {}) => ({ gitBranch: "HEAD", headSha: SHA, remoteMainSha: SHA, dirty: false, ...over });
  const action = (over = {}) => ({
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "recallnet/thwip",
    GITHUB_REPOSITORY_ID: "1315419165",
    GITHUB_SHA: SHA,
    GITHUB_WORKFLOW_REF: "recallnet/thwip/.github/workflows/deploy-staging.yml@refs/heads/main",
    ...over,
  });

  it("requires an explicit scoped token with no D1 permission", () => {
    expect(deployIdentity({}).refusal).toMatch(/never use the ambient Wrangler login/);
    expect(deployIdentity({ CLOUDFLARE_API_TOKEN: "secret" }).refusal).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
    expect(deployIdentity({ CLOUDFLARE_API_TOKEN: "secret", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }).refusal).toBeNull();
    expect(JSON.stringify(deployIdentity({ CLOUDFLARE_API_TOKEN: "secret" }))).not.toContain("secret");
  });

  it("accepts only the exact clean canonical Actions checkout", () => {
    expect(deployCheckout(facts(), action()).refusal).toBeNull();
    for (const [env, changed] of [
      [{ GITHUB_EVENT_NAME: "pull_request" }, {}],
      [{ GITHUB_REF: "refs/heads/topic" }, {}],
      [{ GITHUB_REPOSITORY: "fork/thwip" }, {}],
      [{}, { headSha: "b".repeat(40) }],
      [{}, { dirty: true }],
    ]) expect(deployCheckout(facts(changed), action(env)).refusal).toMatch(/^Refusing/);
    const git = (...args) => args[0] === "status" ? "" : SHA;
    expect(buildStamp(git, action())).toBe(SHA);
    expect(buildStamp((...args) => args[0] === "status" ? " M file" : SHA)).toBe(`${SHA}-dirty`);
  });

  it("uses a fresh deployment generation and requires it in confirmation", async () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    expect(deploymentId(() => second)).toBe(second);
    expect(validDeploymentId("unstamped")).toBe(false);
    const { now, sleep } = clock();
    let call = 0;
    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: SHA,
      expectedDeploymentId: second,
      fetchImpl: async () => response({ buildSha: SHA, projectLifecycle: { workerDeploymentId: [first, second][call++] } }),
      now,
      sleep,
      sleepMs: 1000,
    });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(dirtyShaCaveat(`${SHA}-dirty`)).toMatch(/not unique/);
  });

  it("times out fail-closed when health never serves the deployed SHA", async () => {
    const { now, sleep } = clock();
    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: SHA,
      fetchImpl: async () => response({ buildSha: "old" }),
      now,
      sleep,
      sleepMs: 1000,
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ ok: false, sha: "old" });
  });
});

describe("deploy preflight", () => {
  function fixture({ branch = "main", behind = "0", schema = {} } = {}) {
    const applied = readMigrations(`${ROOT}/migrations`).map(({ name }) => name);
    const git = (...args) => ({
      "rev-parse --abbrev-ref HEAD": branch,
      "rev-parse HEAD": SHA,
      "rev-parse --short HEAD": SHA.slice(0, 7),
      "status --porcelain": "",
      "fetch --quiet origin main": "",
      "rev-parse origin/main": SHA,
      "rev-list --count HEAD..origin/main": behind,
      "branch -r --no-merged HEAD --format=%(refname:short)": "",
    }[args.join(" ")] ?? "");
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/tokens/verify")) return verified();
      if (url.includes("/d1/database/")) return response({ success: false }, 403);
      if (url.endsWith("/v1/schema")) return response({ applied, schema: { track: "legacy", ...schema } });
      throw new Error(`unexpected ${url}`);
    });
    return {
      targetEnv: "staging",
      env: { CLOUDFLARE_API_TOKEN: "deploy-token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      fetchImpl,
      git,
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  }

  it("accepts canonical main only after Cloudflare refuses live D1 access", async () => {
    const input = fixture();
    await expect(preflightDeploy(input)).resolves.toBeUndefined();
    expect(input.fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/d1/database/"), expect.anything());
  });

  it("refuses a non-main or behind checkout without the exact break-glass guard", async () => {
    await expect(preflightDeploy(fixture({ branch: "repair" }))).rejects.toThrow(/unmerged-tree/);
    await expect(preflightDeploy(fixture({ behind: "1" }))).rejects.toThrow(/behind-main/);
  });

  it("refuses an unreadable schema instead of treating it as current", async () => {
    const input = fixture();
    input.fetchImpl = vi.fn(async (url) => {
      if (url.includes("/tokens/verify")) return verified();
      if (url.includes("/d1/database/")) return response({ success: false }, 403);
      return response({}, 500, "broken");
    });
    await expect(preflightDeploy(input)).rejects.toThrow(/schema-unreadable/);
  });

  it("refuses a different migration starting track even with break-glass enabled", async () => {
    const input = fixture({ schema: { track: "baseline" } });
    input.env.THWIP_BREAK_GLASS = `schema-unreadable: ${REASON}`;
    await expect(preflightDeploy(input)).rejects.toThrow(/baseline migration track.*legacy track/);
  });
});

describe("D1 credential isolation", () => {
  it("uses only the named short-lived credential and confirms the live hostname", () => {
    expect(d1CredentialFromEnv({ CLOUDFLARE_API_TOKEN: "broad", THWIP_D1_ACCOUNT_ID: ACCOUNT }, "migration").credential).toBeNull();
    expect(d1CredentialFromEnv({ THWIP_D1_MIGRATION_API_TOKEN: "narrow", THWIP_D1_ACCOUNT_ID: ACCOUNT }, "migration").credential)
      .toMatchObject({ kind: "migration", token: "narrow" });
    expect(liveTargetRefusal(TARGET, null)).toMatch(/--confirm-live must be thwip\.ai/);
    expect(liveTargetRefusal(TARGET, "thwip.ai")).toBeNull();
    expect(liveSchemaUrl("staging")).toBe("https://thwip.ai/v1/schema");
    expect(() => liveSchemaUrl("production")).toThrow(/production/);
  });

  it.each(["read", "migration"])("refuses ambient authority in the real %s command without leaking it", (kind) => {
    const args = kind === "read"
      ? ["scripts/control-plane.mjs", "d1-read", "--env", "staging", "--confirm-live", "thwip.ai", "SELECT 1"]
      : ["scripts/control-plane.mjs", "migrate", "--env", "staging", "--database", TARGET.databaseName, "--confirm-live", "thwip.ai"];
    const secret = "ambient-private-token";
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: secret, THWIP_D1_ACCOUNT_ID: ACCOUNT, THWIP_D1_READ_API_TOKEN: "", THWIP_D1_MIGRATION_API_TOKEN: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/never uses CLOUDFLARE_API_TOKEN/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("accepts a deploy token only when Cloudflare verifies it and live D1 refuses it", async () => {
    const fetchImpl = vi.fn(async (url) => url.includes("/tokens/verify") ? verified() : response({ success: false }, 403));
    await expect(preflightDeployCredential({ fetchImpl, token: "deploy", accountId: ACCOUNT, target: TARGET }))
      .resolves.toEqual({ status: "active", liveD1Access: false });
    await expect(preflightDeployCredential({ fetchImpl: async () => verified(), token: "deploy", accountId: ACCOUNT, target: TARGET }))
      .rejects.toThrow(/can query the live D1/);
  });

  it("requires a short expiry and a non-mutating D1 probe", async () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const credential = { kind: "migration", token: "narrow", accountId: ACCOUNT };
    await expect(preflightD1Credential({
      fetchImpl: async (url) => url.includes("/tokens/verify") ? verified() : d1Probe(),
      credential,
      target: TARGET,
      now,
    })).resolves.toMatchObject({ status: "active", target: "staging/thwip-staging-wnam" });
    await expect(preflightD1Credential({
      fetchImpl: async (url) => url.includes("/tokens/verify") ? verified("2026-08-20T00:00:00Z") : d1Probe(),
      credential,
      target: TARGET,
      now,
    })).rejects.toThrow(/within the next 24 hours/);
  });

  it("strips every ambient credential from the Wrangler child", () => {
    const child = wranglerEnvironment({ CLOUDFLARE_API_TOKEN: "ambient", CLOUDFLARE_API_KEY: "legacy", THWIP_D1_MIGRATION_API_TOKEN: "narrow", SAFE: "kept" }, { token: "narrow", accountId: ACCOUNT });
    expect(child).toMatchObject({ CLOUDFLARE_API_TOKEN: "narrow", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_LOG_SANITIZE: "true", SAFE: "kept" });
    expect(child.CLOUDFLARE_API_KEY).toBeUndefined();
    expect(child.THWIP_D1_MIGRATION_API_TOKEN).toBeUndefined();
  });

  it("calls only explicit authentication rejection proof of revocation", async () => {
    await expect(tokenAcceptance({
      fetchImpl: async () => response({ success: false }, 401),
      token: "deleted",
      accountId: ACCOUNT,
    })).resolves.toEqual({ accepted: false, status: "rejected" });
    await expect(tokenAcceptance({ fetchImpl: async () => verified(), token: "active", accountId: ACCOUNT }))
      .resolves.toEqual({ accepted: true, status: "active" });
    await expect(tokenAcceptance({
      fetchImpl: async () => response({ success: false }, 403),
      token: "uncertain",
      accountId: ACCOUNT,
    })).rejects.toThrow(/Could not prove.*revoked/);
  });

  it("proves both role variables are absent after the token is cleared", () => {
    expect(() => verifyD1CredentialCleared({}, "read")).not.toThrow();
    expect(() => verifyD1CredentialCleared({ THWIP_D1_READ_API_TOKEN: "still-here" }, "read"))
      .toThrow(/still set/);
    expect(() => verifyD1CredentialCleared({ THWIP_D1_ACCOUNT_ID: ACCOUNT }, "migration"))
      .toThrow(/still set/);
  });
});

describe("bounded D1 reads", () => {
  it("runs from a checkout path whose URL contains escaped characters", () => {
    expect(invokedAsMain(
      "/tmp/thwip checkout/scripts/control-plane.mjs",
      "file:///tmp/thwip%20checkout/scripts/control-plane.mjs",
    )).toBe(true);
  });

  it("accepts one read statement and refuses writes or a second statement", () => {
    for (const statement of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN QUERY PLAN SELECT 1"]) {
      expect(refuse(statement)).toBeNull();
    }
    for (const statement of ["SELECT 1; SELECT 2", "DELETE FROM chain", "PRAGMA table_info(chain)", "ANALYZE chain"]) {
      expect(refuse(statement)).not.toBeNull();
    }
    expect(refuse("SELECT created_at, updated_at FROM chain")).toBeNull();
  });

  it("binds remote JSON execution to the named database without echoing private SQL", () => {
    const sql = "SELECT * FROM principals WHERE github_login = 'private-person'";
    const argv = commandFor(sql, { database: TARGET.databaseName, env: "staging" });
    expect(argv).toEqual(["d1", "execute", TARGET.databaseName, "--env", "staging", "--remote", "--json", "--command", sql]);
    expect(readDiagnostic(sql, TARGET)).toMatch(/statement sha256:[0-9a-f]{64}/);
    expect(readDiagnostic(sql, TARGET)).not.toContain("private-person");
    const run = vi.fn(() => { throw new Error(`wrangler ${argv.join(" ")}`); });
    expect(() => executeRead(run, argv, {}))
      .toThrow(/SQL was not repeated/);
    expect(run).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@thwip/control-plane", "exec", "wrangler", ...argv],
      expect.anything(),
    );
  });
});
