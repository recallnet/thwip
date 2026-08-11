import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deployIdentity, liveSchemaUrl } from "./deploy-identity.mjs";

/**
 * Who a deploy runs as.
 *
 * There was one way to deploy: a person ran `deploy:staging` against an
 * interactive wrangler session, and that session carries `d1:write` on the
 * account. The gate then shelled `wrangler d1 migrations list --remote`, so
 * publishing the Worker and administering the database were the same authority
 * and a second contributor could not be given one without the other.
 *
 * A deploy needs to edit one Worker. It says so now, and it says what is
 * missing when the identity it is handed cannot do the job, rather than letting
 * wrangler fail somewhere further in with an error about an account id.
 */
describe("the identity a deploy runs under", () => {
  it("takes a scoped API token with the account it belongs to", () => {
    const identity = deployIdentity({ CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" });
    expect(identity.kind).toBe("scoped-token");
    expect(identity.refusal).toBeNull();
  });

  /**
   * wrangler with a token and no account id fails inside the publish, and the
   * message it gives is about picking an account rather than about the one
   * thing that is missing. That is the "silently needs more than it says"
   * failure, so it is said here instead.
   */
  it("refuses a token with no account, naming the variable that is missing", () => {
    const identity = deployIdentity({ CLOUDFLARE_API_TOKEN: "tok" });
    expect(identity.refusal).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it("still deploys under an interactive session, and says the session carries more than a deploy needs", () => {
    const identity = deployIdentity({});
    expect(identity.kind).toBe("session");
    expect(identity.refusal).toBeNull();
    expect(identity.note).toMatch(/D1/);
    expect(identity.note).toMatch(/docs\/production-access\.md/);
  });

  it("names the two permissions the token needs, so nobody has to guess in the Cloudflare UI", () => {
    expect(deployIdentity({}).note).toMatch(/Workers Scripts:Edit/);
    expect(deployIdentity({}).note).toMatch(/Workers R2 Storage:Edit/);
  });
});

describe("where the gate asks what the live schema is", () => {
  it("reads the origin out of the environment being deployed, so nothing is typed twice", () => {
    expect(liveSchemaUrl("staging")).toBe("https://thwip.ai/v1/schema");
  });

  it("refuses an environment wrangler.jsonc does not define", () => {
    expect(() => liveSchemaUrl("production")).toThrow(/production/);
  });
});

describe("what the deploy command does", () => {
  const scripts = JSON.parse(
    readFileSync(fileURLToPath(new URL("../apps/control-plane/package.json", import.meta.url)), "utf8"),
  ).scripts;

  /**
   * Migrations leave the deploy path. Applying them is a deliberate act under a
   * different identity, so a contributor can ship the Worker without holding a
   * credential that can rewrite the database.
   */
  it("runs no database command from a deploy", () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith("deploy")) continue;
      expect(command, `${name} would need database authority to deploy`).not.toMatch(/\bd1\b/);
    }
  });

  it("keeps applying migrations as its own command", () => {
    expect(scripts["migrate:staging"]).toMatch(/scripts\/migrate\.mjs/);
    expect(scripts["migrate:staging"]).not.toMatch(/d1 migrations apply/);
  });
});
