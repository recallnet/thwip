import {
  appOwnershipRuleset,
  bypassActorsMatch,
  bypassActorsVisible,
  GITHUB_ACTIONS_INTEGRATION_ID,
  OWNERSHIP_RULESET_NAME,
  POLICY_RULESET_NAME,
  policyRuleset,
  rulesetConfigurationMatches,
  type ProofCheckMode,
  type Ruleset,
} from "./rulesets.js";

export interface StoredDoctorRuleset {
  readonly id: number;
  readonly ruleset: Ruleset;
}

export interface ManagedRulesetHealth {
  readonly healthy: boolean;
  readonly expectedNames: readonly string[];
  readonly missing: readonly string[];
  readonly duplicate: readonly string[];
  readonly drifted: readonly string[];
  readonly bypassActorsKnown: boolean;
}

function requiredChecksOf(ruleset: Ruleset): Array<{ context: string; integration_id?: number }> {
  const rule = ruleset.rules.find((candidate) => candidate.type === "required_status_checks");
  const raw = rule?.parameters?.["required_status_checks"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value["context"] !== "string") return [];
    return typeof value["integration_id"] === "number"
      ? [{ context: value["context"], integration_id: value["integration_id"] }]
      : [{ context: value["context"] }];
  });
}

/** Compare both App-owned rulesets with the exact steady-state payload. */
export function managedRulesetHealth(input: {
  readonly rulesets: readonly StoredDoctorRuleset[];
  readonly baseRef: string;
  readonly integrationId: number;
  readonly proofCheckMode: ProofCheckMode;
}): ManagedRulesetHealth {
  const expectedNames: string[] = [OWNERSHIP_RULESET_NAME, POLICY_RULESET_NAME];
  const named = (name: string) => input.rulesets.filter((stored) => stored.ruleset.name === name);
  const missing = expectedNames.filter((name) => named(name).length === 0);
  const duplicate = expectedNames.filter((name) => named(name).length > 1);
  const drifted: string[] = [];

  const ownership = named(OWNERSHIP_RULESET_NAME);
  if (ownership.length === 1) {
    const expected = appOwnershipRuleset({ baseRef: input.baseRef, integrationId: input.integrationId });
    const actual = ownership[0]!.ruleset;
    if (!rulesetConfigurationMatches(actual, expected) || !bypassActorsMatch(actual, expected)) {
      drifted.push(OWNERSHIP_RULESET_NAME);
    }
  }

  const policy = named(POLICY_RULESET_NAME);
  if (policy.length === 1) {
    const actual = policy[0]!.ruleset;
    const expected = policyRuleset({
      baseRef: input.baseRef,
      integrationId: input.integrationId,
      actionsIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
      proofCheckMode: input.proofCheckMode,
      existingRequiredChecks: requiredChecksOf(actual),
      enforcement: "active",
      pinCheckSource: true,
    });
    if (!rulesetConfigurationMatches(actual, expected) || !bypassActorsMatch(actual, expected)) {
      drifted.push(POLICY_RULESET_NAME);
    }
  }

  const bypassActorsKnown = input.rulesets
    .filter((stored) => expectedNames.includes(stored.ruleset.name))
    .every((stored) => bypassActorsVisible(stored.ruleset));
  return {
    healthy: missing.length === 0 && duplicate.length === 0 && drifted.length === 0 && bypassActorsKnown,
    expectedNames,
    missing,
    duplicate,
    drifted,
    bypassActorsKnown,
  };
}
