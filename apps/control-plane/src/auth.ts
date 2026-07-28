import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env.js";

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(env: Env) {
  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
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
      stripe({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_BA_WEBHOOK_SECRET ?? env.STRIPE_WEBHOOK_SECRET ?? "",
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          plans: [
            {
              name: "pro",
              priceId: env.STRIPE_PRICE_MONTHLY,
              annualDiscountPriceId: env.STRIPE_PRICE_ANNUAL,
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
    ],
  });
}
