import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_STEPS,
  bootstrapCheckRuns,
  checkRulesetForBackend,
  diffRuleset,
  GITHUB_ACTIONS_INTEGRATION_ID,
  managedOwnershipRuleset,
  mayActivate,
  nativeMergeQueueRuleset,
  nextBootstrapStep,
  policyRuleset,
  type Ruleset,
} from "./rulesets.js";
import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";

/** The Thwip App. Distinct from GitHub Actions, which sources the proof check. */
const INTEGRATION_ID = 4419870;
const BASE = "refs/heads/main";

function policy(over: Partial<Parameters<typeof policyRuleset>[0]> = {}): Ruleset {
  return policyRuleset({
    baseRef: BASE,
    integrationId: INTEGRATION_ID,
    ...over,
  });
}

function requiredChecks(ruleset: Ruleset): Array<{ context: string; integration_id?: number }> {
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks")!;
  return rule.parameters!["required_status_checks"] as Array<{ context: string; integration_id?: number }>;
}

describe("managedOwnershipRuleset", () => {
  it("lets only the App update the branch and blocks deletion and force-push", () => {
    const ruleset = managedOwnershipRuleset({ baseRef: BASE, integrationId: INTEGRATION_ID });
    expect(ruleset.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "update"]);
    expect(ruleset.bypass_actors).toEqual([
      { actor_id: INTEGRATION_ID, actor_type: "Integration", bypass_mode: "pull_request" },
    ]);
    const update = ruleset.rules.find((r) => r.type === "update")!;
    expect(update.parameters).toEqual({ update_allows_fetch_and_merge: false });
  });
});

describe("policyRuleset", () => {
  it("requires the two checks something actually publishes, each from its own source", () => {
    expect(requiredChecks(policy())).toEqual([
      { context: PROOF_CHECK, integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
      { context: TURN_CHECK, integration_id: INTEGRATION_ID },
    ]);
  });

  it("never requires a context nothing publishes", () => {
    const contexts = requiredChecks(policy()).map((c) => c.context);
    expect(contexts).not.toContain("Thwip / Merge");
  });

  it("carries existing required checks through instead of replacing them", () => {
    const ruleset = policy({
      existingRequiredChecks: [{ context: "build" }, { context: "e2e", integration_id: 42 }],
    });
    const contexts = requiredChecks(ruleset).map((c) => c.context);
    expect(contexts).toContain("build");
    expect(contexts).toContain("e2e");
    expect(contexts).toContain(PROOF_CHECK);
    expect(contexts).toContain(TURN_CHECK);
  });

  it("keeps another check's own source pin", () => {
    const ruleset = policy({ existingRequiredChecks: [{ context: "build", integration_id: 99 }] });
    expect(requiredChecks(ruleset)).toContainEqual({ context: "build", integration_id: 99 });
  });

  it("re-pins a Thwip context a repository had left unsourced", () => {
    const ruleset = policy({ existingRequiredChecks: [{ context: PROOF_CHECK }] });
    expect(requiredChecks(ruleset).filter((c) => c.context === PROOF_CHECK)).toEqual([
      { context: PROOF_CHECK, integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
    ]);
  });

  it("deduplicates a repeated context", () => {
    const ruleset = policy({ existingRequiredChecks: [{ context: "build" }, { context: "build" }] });
    expect(requiredChecks(ruleset).filter((c) => c.context === "build")).toHaveLength(1);
  });

  it("omits the source pin during bootstrap, when GitHub cannot accept one yet", () => {
    expect(requiredChecks(policy({ pinCheckSource: false }))).toEqual([
      { context: PROOF_CHECK },
      { context: TURN_CHECK },
    ]);
  });

  it("does not impose a review model on the repository", () => {
    expect(policy().rules.map((rule) => rule.type)).not.toContain("pull_request");
  });
});

describe("nativeMergeQueueRuleset", () => {
  it("uses group size one and ALLGREEN", () => {
    const rule = nativeMergeQueueRuleset({
      baseRef: BASE,
      integrationId: INTEGRATION_ID,
      mergeMethod: "merge",
      checkResponseTimeoutMinutes: 60,
    }).rules.find((r) => r.type === "merge_queue")!;
    expect(rule.parameters).toMatchObject({
      grouping_strategy: "ALLGREEN",
      max_entries_to_build: 1,
      max_entries_to_merge: 1,
      min_entries_to_merge: 1,
      merge_method: "MERGE",
      check_response_timeout_minutes: 60,
    });
  });

  it("does not carry the managed ownership rule", () => {
    const ruleset = nativeMergeQueueRuleset({
      baseRef: BASE,
      integrationId: INTEGRATION_ID,
      mergeMethod: "squash",
      checkResponseTimeoutMinutes: 60,
    });
    expect(ruleset.rules.map((r) => r.type)).not.toContain("update");
  });
});

describe("checkRulesetForBackend", () => {
  it("refuses managed ownership rules on a native branch", () => {
    const ownership = managedOwnershipRuleset({ baseRef: BASE, integrationId: INTEGRATION_ID });
    expect(checkRulesetForBackend(ownership, "native")).toMatchObject({ ok: false });
    expect(checkRulesetForBackend(ownership, "managed")).toEqual({ ok: true });
  });

  it("refuses a merge_queue rule on a managed branch", () => {
    const native = nativeMergeQueueRuleset({
      baseRef: BASE,
      integrationId: INTEGRATION_ID,
      mergeMethod: "squash",
      checkResponseTimeoutMinutes: 60,
    });
    expect(checkRulesetForBackend(native, "managed")).toMatchObject({ ok: false });
    expect(checkRulesetForBackend(native, "native")).toEqual({ ok: true });
  });
});

describe("diffRuleset", () => {
  it("reports a first-time application as all additions", () => {
    const diff = diffRuleset(null, policy());
    expect(diff.removedRules).toEqual([]);
    expect(diff.addedRequiredChecks).toContain(TURN_CHECK);
    expect(diff.addedRequiredChecks).toContain(PROOF_CHECK);
    expect(diff.safe).toBe(true);
  });

  it("warns loudly when a generated payload would drop an existing check", () => {
    const current = policy({ existingRequiredChecks: [{ context: "e2e" }, { context: "build" }] });
    const next = policy();
    const diff = diffRuleset(current, next);
    expect(diff.removedRequiredChecks.sort()).toEqual(["build", "e2e"]);
    expect(diff.safe).toBe(false);
    expect(diff.warnings.join(" ")).toMatch(/stop requiring build/);
  });

  it("warns when a rule would be removed", () => {
    const current: Ruleset = {
      ...policy(),
      rules: [...policy().rules, { type: "required_signatures" }],
    };
    const diff = diffRuleset(current, policy());
    expect(diff.removedRules).toEqual(["required_signatures"]);
    expect(diff.safe).toBe(false);
  });

  it("warns when enforcement would be turned off", () => {
    const diff = diffRuleset(policy(), policy({ enforcement: "disabled" }));
    expect(diff.enforcementChange).toEqual({ from: "active", to: "disabled" });
    expect(diff.warnings.join(" ")).toMatch(/disable enforcement/);
  });

  it("is safe when a generated payload only adds", () => {
    const current = policy();
    const next = policy({ existingRequiredChecks: [{ context: "build" }] });
    expect(diffRuleset(current, next).safe).toBe(true);
  });
});

describe("bootstrap sequence", () => {
  it("walks the steps in order", () => {
    let progress: Record<string, boolean> = {};
    const walked: string[] = [];
    for (let i = 0; i < BOOTSTRAP_STEPS.length; i += 1) {
      const step = nextBootstrapStep(progress)!;
      walked.push(step);
      progress = { ...progress, [step]: true };
    }
    expect(walked).toEqual([...BOOTSTRAP_STEPS]);
    expect(nextBootstrapStep(progress)).toBeNull();
  });

  it("refuses activation until the canary negative test has passed", () => {
    const almost = {
      "merge-setup-pr": true,
      "create-disabled-policy-without-source": true,
      "publish-bootstrap-check": true,
      "attach-integration-id-while-disabled": true,
    };
    const blocked = mayActivate(almost);
    expect(blocked).toMatchObject({ ok: false });
    if (!blocked.ok) expect(blocked.reason).toMatch(/canary-negative-test/);
    expect(mayActivate({ ...almost, "canary-negative-test": true, "record-genesis": true })).toEqual({
      ok: true,
    });
  });

  it("refuses activation when the source was never attached", () => {
    expect(
      mayActivate({
        "merge-setup-pr": true,
        "create-disabled-policy-without-source": true,
        "publish-bootstrap-check": true,
        "canary-negative-test": true,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("bootstrapCheckRuns", () => {
  it("publishes configuration evidence only while the policy is disabled", () => {
    const ok = bootstrapCheckRuns({ headSha: "a".repeat(40), policyEnforcement: "disabled" });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) {
      expect(ok.checkRuns.map((run) => run.name)).toEqual([TURN_CHECK, PROOF_CHECK]);
      for (const run of ok.checkRuns) {
        expect(run.conclusion).toBe("neutral");
        expect(run.external_id.startsWith("bootstrap:")).toBe(true);
        expect(run.output.summary).toMatch(/not CI and it is not merge verification/);
      }
    }
  });

  /**
   * One per context the policy is about to pin to the App. GitHub offers an App
   * as the expected source of a context only where the App has recently posted
   * a check by that name, and `thwip` moved to the App.
   */
  it("names each context separately so two postings cannot collide", () => {
    const ok = bootstrapCheckRuns({ headSha: "a".repeat(40), policyEnforcement: "disabled" });
    if (!ok.ok) throw new Error("expected configuration evidence");
    expect(new Set(ok.checkRuns.map((run) => run.external_id)).size).toBe(ok.checkRuns.length);
  });

  it("refuses to publish a neutral check against an enforcing policy", () => {
    expect(bootstrapCheckRuns({ headSha: "a".repeat(40), policyEnforcement: "active" })).toMatchObject({
      ok: false,
    });
  });
});
