import { describe, expect, it } from "vitest";
import {
  appOwnershipRuleset,
  GITHUB_ACTIONS_INTEGRATION_ID,
  policyRuleset,
  type Ruleset,
} from "./rulesets.js";
import { managedRulesetHealth, type StoredDoctorRuleset } from "./doctor-rulesets.js";

const BASE_REF = "refs/heads/main";
const APP_ID = 31415;

function healthyRulesets(): StoredDoctorRuleset[] {
  return [
    { id: 1, ruleset: appOwnershipRuleset({ baseRef: BASE_REF, integrationId: APP_ID }) },
    {
      id: 2,
      ruleset: policyRuleset({
        baseRef: BASE_REF,
        integrationId: APP_ID,
        actionsIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
        proofCheckMode: "enforced",
        existingRequiredChecks: [{ context: "repository / lint", integration_id: 99 }],
        enforcement: "active",
        pinCheckSource: true,
      }),
    },
  ];
}

function health(rulesets: StoredDoctorRuleset[]) {
  return managedRulesetHealth({ rulesets, baseRef: BASE_REF, integrationId: APP_ID, proofCheckMode: "enforced" });
}

describe("managed ruleset doctor", () => {
  it("accepts the exact active generated rulesets while preserving unrelated required checks", () => {
    expect(health(healthyRulesets())).toEqual({
      healthy: true,
      expectedNames: ["Thwip Queue Ownership", "Thwip Repository Policy"],
      missing: [],
      duplicate: [],
      drifted: [],
      bypassActorsKnown: true,
      bypassActorsStatus: "verified",
    });
  });

  it("fails when either required ruleset is missing", () => {
    const rulesets = healthyRulesets();
    rulesets.pop();
    expect(health(rulesets)).toMatchObject({ healthy: false, missing: ["Thwip Repository Policy"] });
  });

  it("fails a disabled ruleset instead of counting its name", () => {
    const rulesets = healthyRulesets();
    rulesets[1] = {
      ...rulesets[1]!,
      ruleset: { ...rulesets[1]!.ruleset, enforcement: "disabled" },
    };
    expect(health(rulesets)).toMatchObject({ healthy: false, drifted: ["Thwip Repository Policy"] });
  });

  it("fails the right names with the wrong rule shape or source pin", () => {
    const rulesets = healthyRulesets();
    const ownership = rulesets[0]!.ruleset;
    const policy = rulesets[1]!.ruleset;
    const required = policy.rules.find((rule) => rule.type === "required_status_checks")!;
    const checks = required.parameters!["required_status_checks"] as Array<Record<string, unknown>>;
    rulesets[0] = {
      ...rulesets[0]!,
      ruleset: { ...ownership, rules: ownership.rules.filter((rule) => rule.type !== "non_fast_forward") },
    };
    rulesets[1] = {
      ...rulesets[1]!,
      ruleset: {
        ...policy,
        rules: policy.rules.map((rule) =>
          rule === required
            ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_status_checks: checks.map((check) =>
                    check["context"] === "thwip" ? { ...check, integration_id: 999 } : check,
                  ),
                },
              }
            : rule,
        ),
      },
    };

    expect(health(rulesets)).toMatchObject({
      healthy: false,
      drifted: ["Thwip Queue Ownership", "Thwip Repository Policy"],
    });
  });

  it("fails duplicate managed names rather than choosing one arbitrary ruleset", () => {
    const rulesets = healthyRulesets();
    rulesets.push({ id: 3, ruleset: { ...rulesets[1]!.ruleset } });
    expect(health(rulesets)).toMatchObject({ healthy: false, duplicate: ["Thwip Repository Policy"] });
  });

  it("states when GitHub hid bypass actors while still checking every visible field", () => {
    const rulesets = healthyRulesets().map(({ id, ruleset }) => {
      const { bypass_actors: _hidden, ...visible } = ruleset;
      return { id, ruleset: visible as Ruleset };
    });
    expect(health(rulesets)).toMatchObject({
      healthy: false,
      bypassActorsKnown: false,
      bypassActorsStatus: "unreadable",
    });
  });

  it("distinguishes visible incorrect bypass actors from hidden actors", () => {
    const rulesets = healthyRulesets();
    rulesets[0] = {
      ...rulesets[0]!,
      ruleset: { ...rulesets[0]!.ruleset, bypass_actors: [] },
    };
    expect(health(rulesets)).toMatchObject({
      healthy: false,
      bypassActorsKnown: true,
      bypassActorsStatus: "incorrect",
      drifted: ["Thwip Queue Ownership"],
    });
  });
});
