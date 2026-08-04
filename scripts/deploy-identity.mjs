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
  "Zone / Workers Routes:Edit (recall.net)",
  "and no D1 permission of any kind",
];

const SESSION_NOTE = [
  "Deploying under the interactive wrangler session.",
  "That session carries everything the account carries, D1 included, and a deploy needs none of it.",
  "Create a scoped token with exactly these permissions and export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID:",
  ...DEPLOY_TOKEN_PERMISSIONS.map((permission) => `  ${permission}`),
  "The token must hold no D1 permission. See docs/production-access.md.",
].join("\n");

/**
 * Which credential this deploy will use, and what stops it if anything does.
 *
 * A refusal here is a refusal about the identity, not about the Worker. The one
 * case worth refusing is a token with no account: wrangler accepts it, gets
 * most of the way through a publish, and then fails with a message about
 * choosing an account, which reads as a wrangler problem rather than a missing
 * variable.
 */
export function deployIdentity(env) {
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  if (token.length === 0) {
    return { kind: "session", refusal: null, note: SESSION_NOTE };
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (account.length === 0) {
    return {
      kind: "scoped-token",
      refusal:
        "Refusing: CLOUDFLARE_API_TOKEN is set and CLOUDFLARE_ACCOUNT_ID is not.\n" +
        "wrangler gets most of the way through the publish before it asks which account this is.",
      note: SESSION_NOTE,
    };
  }
  return {
    kind: "scoped-token",
    refusal: null,
    note: `Deploying under CLOUDFLARE_API_TOKEN on account ${account}.`,
  };
}

/**
 * The live Worker's schema endpoint for an environment.
 *
 * Read out of `wrangler.jsonc` rather than written down again, because a
 * hard-coded origin is how a gate comes to check an environment nobody is
 * deploying.
 */
export function liveSchemaUrl(env) {
  const config = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
  const json = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
  const origin = json.env?.[env]?.vars?.PUBLIC_ORIGIN;
  if (typeof origin !== "string") {
    throw new Error(`wrangler.jsonc defines no PUBLIC_ORIGIN for --env ${env}`);
  }
  return `${origin.replace(/\/$/, "")}/v1/schema`;
}
