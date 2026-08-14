import { describe, expect, it } from "vitest";
import { stripeBillingConfiguration } from "./auth.js";

describe("optional Stripe billing", () => {
  it("is disabled when a deployment supplies no Stripe settings", () => {
    expect(stripeBillingConfiguration({})).toBeNull();
    expect(stripeBillingConfiguration({ BILLING_MODE: "disabled" })).toBeNull();
  });

  it("accepts one complete hosted billing configuration", () => {
    const hosted = {
      STRIPE_SECRET_KEY: "sk_test_example",
      STRIPE_PRICE_MONTHLY: "price_monthly",
      STRIPE_PRICE_ANNUAL: "price_annual",
      STRIPE_BA_WEBHOOK_SECRET: "whsec_example",
    };
    expect(stripeBillingConfiguration(hosted)).toEqual({
      secretKey: "sk_test_example",
      monthlyPriceId: "price_monthly",
      annualPriceId: "price_annual",
      webhookSecret: "whsec_example",
    });
    expect(stripeBillingConfiguration({ ...hosted, BILLING_MODE: "stripe" })).not.toBeNull();
    expect(stripeBillingConfiguration({ ...hosted, STRIPE_BA_WEBHOOK_SECRET: undefined }))
      .toMatchObject({ webhookSecret: "" });
  });

  it("refuses a partial Stripe setup", () => {
    expect(() =>
      stripeBillingConfiguration({
        BILLING_MODE: "stripe",
        STRIPE_SECRET_KEY: "sk_test_example",
      }),
    ).toThrow("Stripe billing is incomplete");
  });

  it("refuses an unknown billing mode", () => {
    expect(() =>
      stripeBillingConfiguration({ BILLING_MODE: "other" as "stripe" }),
    ).toThrow("Unknown BILLING_MODE");
  });
});
