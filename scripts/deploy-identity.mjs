/**
 * Who a deploy runs as, and where it asks what the live schema is.
 *
 * There was one way to deploy this: a person ran `deploy:staging` from a laptop
 * against an interactive wrangler session. That session holds every permission
 * the account holds, including `d1:write`, and the gate then shelled
 * `wrangler d1 migrations list --remote`, so publishing the Worker and
 * administering the database were one authority. A second contributor could not
 * be given the first without the second, which is issue #31.
 *
 * Two things change. The schema question is asked over HTTP, of the Worker that
 * already holds the binding, so the gate needs no Cloudflare credential at all.
 * And applying migrations leaves the deploy path entirely: `migrate:staging` is
 * its own command, run deliberately, by whoever holds database authority.
 *
 * What is left for a deploy is editing one Worker. This says so.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What a deploy token has to be able to do, in the words the Cloudflare UI uses. */
export const DEPLOY_TOKEN_PERMISSIONS = [
  "Account / Workers Scripts:Edit",
  "Account / Workers R2 Storage:Edit",
  "Account / Workers KV Storage:Edit",
  "Account / Queues:Edit",
  "Account / Workers Tail:Read",
  "Account / Account Settings:Read",
  "User / User Details:Read",
  "User / Memberships:Read",
  "Zone / Workers Routes:Edit (thwip.ai)",
];

const SCOPED_TOKEN_INSTRUCTIONS = [
  "Create a scoped deploy token with exactly these permissions:",
  ...DEPLOY_TOKEN_PERMISSIONS.map((permission) => `  ${permission}`),
  "Give it no D1 permission. Export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
  "See docs/production-access.md.",
].join("\n");

/**
 * Which credential this deploy will use, and what stops it if anything does.
 *
 * Ambient Wrangler OAuth is not a deploy identity. It can carry D1 write
 * authority that a deploy never needs. Falling back to it would silently join
 * Worker publishing and database administration again.
 */
export function deployIdentity(env) {
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  if (token.length === 0) {
    return {
      kind: "missing",
      refusal:
        "Refusing: deploys require an explicit CLOUDFLARE_API_TOKEN and never use the ambient Wrangler login.\n" +
        SCOPED_TOKEN_INSTRUCTIONS,
      note: "No scoped deploy token is configured.",
    };
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (account.length === 0) {
    return {
      kind: "scoped-token",
      refusal:
        "Refusing: CLOUDFLARE_API_TOKEN is set and CLOUDFLARE_ACCOUNT_ID is not.\n" +
        "wrangler gets most of the way through the publish before it asks which account this is.",
      note: "The scoped deploy token has no configured account.",
    };
  }
  return {
    kind: "scoped-token",
    refusal: null,
    note: "Deploying under the explicit scoped deploy token.",
  };
}

/** The complete live D1 target for an environment. */
export function liveD1Target(env) {
  const config = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
  const json = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
  const configured = json.env?.[env];
  const origin = configured?.vars?.PUBLIC_ORIGIN;
  const database = configured?.d1_databases?.find((candidate) => candidate.binding === "DB");
  if (
    typeof origin !== "string" ||
    typeof database?.database_name !== "string" ||
    typeof database.database_id !== "string"
  ) {
    throw new Error(`wrangler.jsonc defines no complete live D1 target for --env ${env}`);
  }
  return {
    env,
    origin: origin.replace(/\/$/, ""),
    databaseName: database.database_name,
    databaseId: database.database_id,
  };
}

/**
 * The live Worker's origin for an environment, read out of `wrangler.jsonc`
 * rather than written down again, because a hard-coded origin is how a gate
 * comes to check an environment nobody is deploying.
 */
function liveOrigin(env) {
  return liveD1Target(env).origin;
}

/** The live Worker's schema endpoint for an environment. */
export function liveSchemaUrl(env) {
  return `${liveOrigin(env)}/v1/schema`;
}

/**
 * The live Worker's health endpoint for an environment, which is the only
 * place the Worker says which build it is running (`buildSha`, from
 * `apps/control-plane/src/index.ts`'s `/health` route).
 */
export function liveHealthUrl(env) {
  return `${liveOrigin(env)}/health`;
}
