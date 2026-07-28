// CLI-only Better Auth config used exclusively for schema generation
// (`@better-auth/cli generate`). Mirrors the plugin set of src/auth.ts so the
// generated SQL matches the runtime schema; never imported by the Worker.
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import Database from "better-sqlite3";

export const auth = betterAuth({
  baseURL: "https://thwip.recall.net",
  secret: "schema-generation-only",
  database: new Database(":memory:"),
  account: { encryptOAuthTokens: true },
  socialProviders: {
    github: { clientId: "x", clientSecret: "x" },
  },
  plugins: [
    bearer(),
    organization(),
    deviceAuthorization({}),
    stripe({
      stripeClient: new Stripe("sk_test_x"),
      stripeWebhookSecret: "whsec_x",
      subscription: { enabled: true, plans: [{ name: "pro", priceId: "price_x" }] },
    }),
  ],
});
