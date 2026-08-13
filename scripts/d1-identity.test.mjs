import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  d1CredentialFromEnv,
  liveTargetRefusal,
  preflightD1Credential,
  preflightDeployCredential,
  tokenAcceptance,
  wranglerEnvironment,
} from "./d1-identity.mjs";
import { liveD1Target } from "./deploy-identity.mjs";

const TARGET = liveD1Target("staging");
const NOW = Date.parse("2026-08-12T12:00:00Z");
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function verified(expiresOn = "2026-08-13T00:00:00Z") {
  return response({ success: true, result: { status: "active", expires_on: expiresOn } });
}

function successfulProbe() {
  return response({
    success: true,
    result: [
      {
        success: true,
        results: [{ thwip_d1_preflight: 1 }],
        meta: { changed_db: false, rows_written: 0 },
      },
    ],
  });
}

describe("choosing a D1 identity", () => {
  it("refuses an ambient deploy token and Wrangler session for migrations", () => {
    const selected = d1CredentialFromEnv(
      { CLOUDFLARE_API_TOKEN: "broad-token", THWIP_D1_ACCOUNT_ID: "a".repeat(32) },
      "migration",
    );
    expect(selected.credential).toBeNull();
    expect(selected.refusal).toMatch(/THWIP_D1_MIGRATION_API_TOKEN/);
    expect(selected.refusal).toMatch(/never uses CLOUDFLARE_API_TOKEN/);
  });

  it("accepts the separate named migration credential and account", () => {
    const selected = d1CredentialFromEnv(
      { THWIP_D1_MIGRATION_API_TOKEN: "migration-token", THWIP_D1_ACCOUNT_ID: "a".repeat(32) },
      "migration",
    );
    expect(selected.refusal).toBeNull();
    expect(selected.credential).toMatchObject({ kind: "migration", accountId: "a".repeat(32) });
  });

  it("requires an explicit acknowledgement of the live hostname", () => {
    expect(liveTargetRefusal(TARGET, null)).toMatch(/--confirm-live must be thwip\.ai/);
    expect(liveTargetRefusal(TARGET, "thwip.ai")).toBeNull();
  });

  it.each([
    ["read", ["scripts/d1.mjs", "--env", "staging", "--confirm-live", "thwip.ai", "SELECT 1"]],
    [
      "migration",
      [
        "scripts/migrate.mjs",
        "--env",
        "staging",
        "--database",
        TARGET.databaseName,
        "--confirm-live",
        "thwip.ai",
      ],
    ],
  ])("refuses an ambient token in the real %s command without printing it", (kind, args) => {
    const secret = "ambient-private-token";
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: secret,
        THWIP_D1_ACCOUNT_ID: "a".repeat(32),
        THWIP_D1_READ_API_TOKEN: "",
        THWIP_D1_MIGRATION_API_TOKEN: "",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/never uses CLOUDFLARE_API_TOKEN/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});

describe("preflighting a deploy token", () => {
  it("accepts an active scoped deploy token only when live D1 refuses it", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/verify") ? verified() : response({ success: false, errors: [{ code: 10000 }] }, 403),
    );
    await expect(
      preflightDeployCredential({
        fetchImpl,
        token: "deploy-token",
        accountId: "a".repeat(32),
        target: TARGET,
      }),
    ).resolves.toEqual({ status: "active", liveD1Access: false });
  });

  it("refuses a deploy token that can query live D1", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/verify")
        ? verified()
        : response({ success: true, result: [{ success: true, results: [{ thwip_deploy_d1_probe: 1 }] }] }),
    );
    await expect(
      preflightDeployCredential({
        fetchImpl,
        token: "deploy-token",
        accountId: "a".repeat(32),
        target: TARGET,
      }),
    ).rejects.toThrow(/can query the live D1/);
  });
});

describe("preflighting a D1 token", () => {
  it("accepts a short-lived token that can perform the non-mutating target probe", async () => {
    const fetchImpl = vi.fn(async (url) => (url.endsWith("/verify") ? verified() : successfulProbe()));
    await expect(
      preflightD1Credential({
        fetchImpl,
        credential: { kind: "migration", token: "migration-token", accountId: "a".repeat(32) },
        target: TARGET,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: "active",
      expiresOn: "2026-08-13T00:00:00.000Z",
      target: "staging/thwip-staging-wnam",
    });
  });

  it("refuses a long-lived D1 token before querying the database", async () => {
    const fetchImpl = vi.fn(async () => verified("2026-08-20T00:00:00Z"));
    await expect(
      preflightD1Credential({
        fetchImpl,
        credential: { kind: "migration", token: "migration-token", accountId: "a".repeat(32) },
        target: TARGET,
        now: NOW,
      }),
    ).rejects.toThrow(/within the next 24 hours/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports no token or private result when the probe fails", async () => {
    const secret = "private-migration-token";
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("/verify") ? verified() : response({ success: false, errors: [{ message: "denied" }] }, 403),
    );
    let message = "";
    try {
      await preflightD1Credential({
        fetchImpl,
        credential: { kind: "migration", token: secret, accountId: "a".repeat(32) },
        target: TARGET,
        now: NOW,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/non-mutating probe/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("denied");
  });
});

describe("the Wrangler child identity", () => {
  it("removes ambient credentials and passes only the selected token", () => {
    const child = wranglerEnvironment(
      {
        CLOUDFLARE_API_TOKEN: "ambient-token",
        CLOUDFLARE_API_KEY: "legacy-key",
        CLOUDFLARE_EMAIL: "operator@example.com",
        THWIP_D1_MIGRATION_API_TOKEN: "migration-token",
        THWIP_D1_ACCOUNT_ID: "a".repeat(32),
        SAFE_VALUE: "kept",
      },
      { token: "migration-token", accountId: "a".repeat(32) },
    );
    expect(child.CLOUDFLARE_API_TOKEN).toBe("migration-token");
    expect(child.CLOUDFLARE_ACCOUNT_ID).toBe("a".repeat(32));
    expect(child.CLOUDFLARE_API_KEY).toBeUndefined();
    expect(child.CLOUDFLARE_EMAIL).toBeUndefined();
    expect(child.THWIP_D1_MIGRATION_API_TOKEN).toBeUndefined();
    expect(child.THWIP_D1_ACCOUNT_ID).toBeUndefined();
    expect(child.SAFE_VALUE).toBe("kept");
    expect(child.WRANGLER_LOG_SANITIZE).toBe("true");
  });
});

describe("post-use revocation", () => {
  it("treats Cloudflare's authentication rejection as revoked", async () => {
    const fetchImpl = vi.fn(async () => response({ success: false, errors: [{ code: 9109 }] }, 401));
    await expect(tokenAcceptance({ fetchImpl, token: "deleted-token" })).resolves.toEqual({
      accepted: false,
      status: "rejected",
    });
  });

  it("refuses to call an active token revoked", async () => {
    const fetchImpl = vi.fn(async () => verified());
    await expect(tokenAcceptance({ fetchImpl, token: "active-token" })).resolves.toEqual({
      accepted: true,
      status: "active",
    });
  });

  it("does not treat an ambiguous permission refusal as proof of revocation", async () => {
    const fetchImpl = vi.fn(async () => response({ success: false, errors: [{ code: 10000 }] }, 403));
    await expect(tokenAcceptance({ fetchImpl, token: "uncertain-token" })).rejects.toThrow(
      /Could not prove.*revoked/,
    );
  });
});
