import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env.js";

export type Auth = ReturnType<typeof createAuth>;

export interface StripeBillingConfiguration {
  readonly secretKey: string;
  readonly monthlyPriceId: string;
  readonly annualPriceId: string;
  readonly webhookSecret: string;
}

/**
 * Return one complete Stripe configuration, or null when billing is disabled.
 *
 * Existing hosted deployments remain compatible: supplying Stripe settings
 * without BILLING_MODE still enables billing. A partial setup fails loudly so
 * a typo cannot leave subscription routes accepting incomplete configuration.
 */
export function stripeBillingConfiguration(
  env: Pick<
    Env,
    | "BILLING_MODE"
    | "STRIPE_SECRET_KEY"
    | "STRIPE_PRICE_MONTHLY"
    | "STRIPE_PRICE_ANNUAL"
    | "STRIPE_BA_WEBHOOK_SECRET"
    | "STRIPE_WEBHOOK_SECRET"
  >,
): StripeBillingConfiguration | null {
  if (env.BILLING_MODE !== undefined && !["stripe", "disabled"].includes(env.BILLING_MODE)) {
    throw new Error(`Unknown BILLING_MODE: ${String(env.BILLING_MODE)}`);
  }
  if (env.BILLING_MODE === "disabled") return null;
  const required = {
    secretKey: env.STRIPE_SECRET_KEY,
    monthlyPriceId: env.STRIPE_PRICE_MONTHLY,
    annualPriceId: env.STRIPE_PRICE_ANNUAL,
  };
  const webhookSecret = env.STRIPE_BA_WEBHOOK_SECRET ?? env.STRIPE_WEBHOOK_SECRET ?? "";
  const supplied = [...Object.values(required), webhookSecret]
    .filter((value) => typeof value === "string" && value.length > 0).length;
  if (env.BILLING_MODE !== "stripe" && supplied === 0) return null;
  const missing = Object.entries(required)
    .filter(([, value]) => typeof value !== "string" || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Stripe billing is incomplete: missing ${missing.join(", ")}`);
  }
  return { ...required, webhookSecret } as StripeBillingConfiguration;
}

export function createAuth(env: Env) {
  const billing = stripeBillingConfiguration(env);
  return betterAuth({
    baseURL: env.PUBLIC_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: "sqlite",
    },
    account: {
      encryptOAuthTokens: true,
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      },
    },
    plugins: [
      bearer(),
      organization(),
      deviceAuthorization({
        expiresIn: "30m",
        interval: "5s",
      }),
      ...(billing === null
        ? []
        : [
            stripe({
              stripeClient: new Stripe(billing.secretKey, {
                httpClient: Stripe.createFetchHttpClient(),
              }),
              stripeWebhookSecret: billing.webhookSecret,
              createCustomerOnSignUp: false,
              subscription: {
                enabled: true,
                plans: [
                  {
                    name: "pro",
                    priceId: billing.monthlyPriceId,
                    annualDiscountPriceId: billing.annualPriceId,
                    limits: { projects: 15, users: 25 },
                  },
                ],
                authorizeReference: async ({ user, referenceId }) => {
                  // Only projected owners/admins of the Better Auth organization
                  // may manage its subscription.
                  const row = await env.DB.prepare(
                    `SELECT role FROM member WHERE userId = ? AND organizationId = ?`,
                  )
                    .bind(user.id, referenceId)
                    .first<{ role: string }>();
                  return row?.role === "owner" || row?.role === "admin";
                },
              },
            }),
          ]),
    ],
  });
}
