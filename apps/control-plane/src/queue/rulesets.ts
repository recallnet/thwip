/**
 * Ruleset generation for the App-owned queue.
 *
 * Two rules govern everything here. Unrelated controls are merged, never
 * replaced: a generated payload that dropped someone's existing protection would
 * be a security regression delivered by a setup tool. The App is the only
 * supported writer, so a merge-queue rule is always a conflicting control.
 */

import { PROOF_CHECK, TURN_CHECK, WORKFLOW_CHECK } from "./turn-check.js";

/*
 * `Thwip / Merge` is gone.
 *
 * The v1 design named one App-published gate by that name. The queue that got
 * built publishes distinct workflow and App checks and none of them is called
 * that: `thwip / workflow` from `.github/workflows/thwip-required.yml`, and
 * `thwip`, `thwip / turn`, and `thwip / candidate` from the App. A repository provisioned from the old
 * generator required a check no source would ever post, so its branch could not
 * merge and no amount of waiting would change that.
 *
 * The pin came out first, then the builder that nothing called and the
 * publisher that nothing called. What the check was going to say now goes on
 * `thwip / turn`, which is required and which developers already open.
 */

/**
 * GitHub Actions' own Integration id, which is the same everywhere.
 *
 * Observe mode uses the repository workflow's `thwip / workflow` context and
 * pins it to Actions. Enforced mode uses the App's `thwip` context and pins it
 * to the App. The names differ as well as the sources so GitHub never has to
 * choose between two same-named checks while the App advances the branch.
 */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/**
 * Whether the App publishes the enforced `thwip` name yet.
 *
 * `observe` publishes `thwip / proof (observe)` and never `thwip`, so a pin on
 * the App would leave the branch requiring a check with no publisher and every
 * open pull request stuck. The publisher moves first and the pin follows it.
 */
export type ProofCheckMode = "observe" | "enforced";

/** The proof context that actually exists in this stage of setup. */
export function proofContextFor(mode: ProofCheckMode): typeof WORKFLOW_CHECK | typeof PROOF_CHECK {
  return mode === "enforced" ? PROOF_CHECK : WORKFLOW_CHECK;
}

/** Which Integration may satisfy the active proof context. */
export function proofIntegrationFor(input: {
  mode: ProofCheckMode;
  integrationId: number;
  actionsIntegrationId?: number;
}): number {
  return input.mode === "enforced"
    ? input.integrationId
    : (input.actionsIntegrationId ?? GITHUB_ACTIONS_INTEGRATION_ID);
}

export const OWNERSHIP_RULESET_NAME = "Thwip Queue Ownership" as const;
export const POLICY_RULESET_NAME = "Thwip Repository Policy" as const;

export interface RulesetRule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Ruleset {
  readonly name: string;
  readonly target: "branch";
  /** GitHub may also return `evaluate`; generated writes use active or disabled. */
  readonly enforcement: "active" | "disabled" | "evaluate";
  readonly bypass_actors: ReadonlyArray<Record<string, unknown>>;
  readonly conditions: { readonly ref_name: { readonly include: readonly string[]; readonly exclude: readonly string[] } };
  readonly rules: readonly RulesetRule[];
}

export interface PolicyOptions {
  readonly baseRef: string;
  /** The Thwip App, which publishes the turn check. */
  readonly integrationId: number;
  /** GitHub Actions, which publishes the workflow proof gate while the App observes. */
  readonly actionsIntegrationId?: number;
  /** Whether the App publishes `thwip` itself yet. Defaults to observing. */
  readonly proofCheckMode?: ProofCheckMode;
  /** Checks the repository already requires, which must survive generation. */
  readonly existingRequiredChecks?: ReadonlyArray<{ context: string; integration_id?: number }>;
  readonly enforcement?: "active" | "disabled";
  /** Omitted while bootstrapping the context, before the source can be pinned. */
  readonly pinCheckSource?: boolean;
}

function refCondition(baseRef: string): Ruleset["conditions"] {
  return { ref_name: { include: [baseRef], exclude: [] } };
}

/**
 * Only the Thwip App may update the queued branch, because the App performs the
 * merge. The App needs an `always` bypass because its writer creates the exact
 * merge commit and advances the ref directly; GitHub's `pull_request` bypass
 * applies only to updates made through GitHub's pull-request merge path and
 * refuses that guarded ref update. No user or team receives a bypass, and the
 * writer itself still hard-codes `force: false`. Deletion and force-push stay
 * blocked for everyone else.
 */
export function appOwnershipRuleset(input: { baseRef: string; integrationId: number }): Ruleset {
  return {
    name: OWNERSHIP_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [
      { actor_id: input.integrationId, actor_type: "Integration", bypass_mode: "always" },
    ],
    conditions: refCondition(input.baseRef),
    rules: [
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  };
}

/**
 * The repository policy contains only the checks and ref-integrity controls the
 * queue owns. Review policy belongs to the repository's existing rulesets,
 * which GitHub layers with this one; setup must not invent approvals, dismissal
 * behavior, last-push approval, or thread-resolution requirements.
 *
 * The active proof context answers whether the proof is good for this tree. `thwip / turn`
 * answers whose turn it is and is published by the App the moment it offers the
 * lane, so the App is its source. The proof gate changes both name and source at
 * enforcement: Actions owns `thwip / workflow`, while the App owns `thwip`.
 * Naming the wrong stage makes the context unsatisfiable and wedges the branch.
 *
 * Existing required checks are carried through, deduplicated by context, with
 * the caller's own source pin winning for the managed Thwip contexts only.
 */
export function policyRuleset(input: PolicyOptions): Ruleset {
  const proofMode = input.proofCheckMode ?? "observe";
  const proofContext = proofContextFor(proofMode);
  const proofIntegrationId = proofIntegrationFor({
    mode: proofMode,
    integrationId: input.integrationId,
    ...(input.actionsIntegrationId === undefined ? {} : { actionsIntegrationId: input.actionsIntegrationId }),
  });
  const thwipContexts = new Set<string>([PROOF_CHECK, WORKFLOW_CHECK, TURN_CHECK]);
  const existing = input.existingRequiredChecks ?? [];
  const merged: Array<{ context: string; integration_id?: number }> = [];
  const seen = new Set<string>();
  for (const check of existing) {
    if (thwipContexts.has(check.context)) continue; // replaced below, deliberately
    if (seen.has(check.context)) continue;
    seen.add(check.context);
    merged.push(check.integration_id === undefined ? { context: check.context } : { ...check });
  }
  if (input.pinCheckSource === false) {
    merged.push({ context: proofContext }, { context: TURN_CHECK });
  } else {
    merged.push(
      { context: proofContext, integration_id: proofIntegrationId },
      { context: TURN_CHECK, integration_id: input.integrationId },
    );
  }

  return {
    name: POLICY_RULESET_NAME,
    target: "branch",
    enforcement: input.enforcement ?? "active",
    bypass_actors: [],
    conditions: refCondition(input.baseRef),
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: true,
          strict_required_status_checks_policy: false,
          required_status_checks: merged,
        },
      },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  };
}

/** Guard against mixing GitHub's merge queue with the App-owned branch. */
export type AppRulesetCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkAppRuleset(ruleset: Ruleset): AppRulesetCheck {
  const types = new Set(ruleset.rules.map((rule) => rule.type));
  if (types.has("merge_queue")) {
    return { ok: false, reason: "an App-owned branch must not carry GitHub's merge_queue rule" };
  }
  return { ok: true };
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const unmatched = [...actual];
    for (const value of expected) {
      const index = unmatched.findIndex((candidate) => matchesExpected(candidate, value));
      if (index === -1) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) => matchesExpected(record[key], value));
  }
  return Object.is(actual, expected);
}

/**
 * Compare GitHub's read-back with a generated managed ruleset. Server-owned
 * response fields are ignored, but every field Thwip owns must match. GitHub
 * can hide bypass actors from an App without Administration write; callers
 * compare those separately when they are visible.
 */
export function rulesetConfigurationMatches(actual: Ruleset, expected: Ruleset): boolean {
  const { bypass_actors: _ignored, ...visibleExpected } = expected;
  // GitHub drops this false-valued object on read-back. Normalize it to the
  // explicit safe value generated by setup.
  const normalizedActual = {
    ...actual,
    rules: actual.rules.map((rule) =>
      rule.type === "update" && rule.parameters === undefined
        ? { ...rule, parameters: { update_allows_fetch_and_merge: false } }
        : rule,
    ),
  };
  return matchesExpected(normalizedActual, visibleExpected);
}

export function bypassActorsVisible(ruleset: Ruleset): boolean {
  return Object.hasOwn(ruleset, "bypass_actors");
}

export function bypassActorsMatch(actual: Ruleset, expected: Ruleset): boolean {
  return !bypassActorsVisible(actual) || matchesExpected(actual.bypass_actors, expected.bypass_actors);
}

/* ------------------------------------------------------------------ */

/**
 * A semantic diff of what applying a generated ruleset would change (§44.1
 * step 3). Setup shows this before anything is submitted, because "we merged
 * your rules" has to be verifiable rather than asserted.
 */
export interface RulesetDiff {
  readonly addedRules: readonly string[];
  readonly removedRules: readonly string[];
  readonly addedRequiredChecks: readonly string[];
  readonly removedRequiredChecks: readonly string[];
  readonly enforcementChange: { readonly from: string; readonly to: string } | null;
  readonly safe: boolean;
  readonly warnings: readonly string[];
}

function requiredChecksOf(ruleset: Ruleset): string[] {
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  const checks = (rule?.parameters?.["required_status_checks"] ?? []) as ReadonlyArray<{ context?: string }>;
  return checks.map((c) => c.context ?? "").filter((c) => c !== "");
}

export function diffRuleset(current: Ruleset | null, next: Ruleset): RulesetDiff {
  const currentTypes = new Set(current?.rules.map((r) => r.type) ?? []);
  const nextTypes = new Set(next.rules.map((r) => r.type));
  const currentChecks = new Set(current === null ? [] : requiredChecksOf(current));
  const nextChecks = new Set(requiredChecksOf(next));

  const removedRules = [...currentTypes].filter((t) => !nextTypes.has(t));
  const removedRequiredChecks = [...currentChecks].filter((c) => !nextChecks.has(c));
  const warnings: string[] = [];
  const managedProofContexts = new Set<string>([PROOF_CHECK, WORKFLOW_CHECK]);
  const nextHasManagedProof = [...managedProofContexts].some((context) => nextChecks.has(context));

  // Dropping a protection is the outcome this diff exists to make visible.
  for (const rule of removedRules) warnings.push(`this would remove the ${rule} rule`);
  for (const check of removedRequiredChecks) {
    // Observe and enforced mode deliberately use different proof contexts.
    // Replacing one with the other is the setup protocol's source cutover, not
    // the removal of a repository-owned protection. Dropping either without a
    // managed proof gate replacing it remains unsafe.
    if (managedProofContexts.has(check) && nextHasManagedProof) continue;
    warnings.push(`this would stop requiring ${check}`);
  }
  if (current !== null && current.enforcement === "active" && next.enforcement === "disabled") {
    warnings.push("this would disable enforcement");
  }

  return {
    addedRules: [...nextTypes].filter((t) => !currentTypes.has(t)),
    removedRules,
    addedRequiredChecks: [...nextChecks].filter((c) => !currentChecks.has(c)),
    removedRequiredChecks,
    enforcementChange:
      current === null || current.enforcement === next.enforcement
        ? null
        : { from: current.enforcement, to: next.enforcement },
    safe: warnings.length === 0,
    warnings,
  };
}

/* ------------------------------------------------------------------ */

/**
 * The source bootstrap sequence (§44.3). GitHub will not let a brand-new context
 * be source-pinned in one step: the context must already exist as a requirement,
 * and the App must have recently published a check with that name, before the
 * App can be selected as its expected source.
 *
 * Encoding the order here keeps setup from doing the tempting thing — creating an
 * active pinned ruleset immediately — which fails and can leave a branch
 * requiring a check nothing will ever post.
 */
export const BOOTSTRAP_STEPS = [
  "merge-setup-pr",
  "create-disabled-policy-without-source",
  "publish-bootstrap-check",
  "attach-integration-id-while-disabled",
  "canary-negative-test",
  "record-genesis",
  "pin-proof-check-to-app",
  "activate-policy-and-ownership",
] as const;

export type BootstrapStep = (typeof BOOTSTRAP_STEPS)[number];

export type BootstrapProgress = Partial<Record<BootstrapStep, boolean>>;

export function nextBootstrapStep(progress: BootstrapProgress): BootstrapStep | null {
  for (const step of BOOTSTRAP_STEPS) if (progress[step] !== true) return step;
  return null;
}

export type ActivationCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Refuse to activate an enforcing policy until the source pin has been proven.
 * Without the canary test, activation can require a check whose source was never
 * verified, which is how a branch ends up permanently unmergeable.
 */
export function mayActivate(progress: BootstrapProgress): ActivationCheck {
  const required: BootstrapStep[] = [
    "merge-setup-pr",
    "create-disabled-policy-without-source",
    "publish-bootstrap-check",
    "attach-integration-id-while-disabled",
    "canary-negative-test",
    "record-genesis",
    "pin-proof-check-to-app",
  ];
  for (const step of required) {
    if (progress[step] !== true) return { ok: false, reason: `${step} has not been completed` };
  }
  return { ok: true };
}

/**
 * The bootstrap checks are configuration evidence, not verdicts. They may be
 * neutral only while the policy is disabled, and they are never copied into an
 * attempt or a certificate (§44.3).
 *
 * GitHub offers an App as the expected source of a context only where the App
 * has recently posted a check by that name, so the App posts one for each
 * context the policy is about to pin to it. `thwip / turn` has always been one
 * of them. `thwip` joins it because setup eventually pins the enforced proof
 * gate to the App. The Actions-owned `thwip / workflow` context is never posted
 * by the App; keeping the publishers disjoint is the invariant this setup is
 * establishing.
 */
export function bootstrapCheckRuns(input: { headSha: string; policyEnforcement: "active" | "disabled" }):
  | { readonly ok: true; readonly checkRuns: ReadonlyArray<{ name: string; head_sha: string; status: string; conclusion: string; external_id: string; output: { title: string; summary: string } }> }
  | { readonly ok: false; readonly reason: string } {
  if (input.policyEnforcement !== "disabled") {
    return { ok: false, reason: "a bootstrap check may only be published while the policy is disabled" };
  }
  return {
    ok: true,
    checkRuns: [TURN_CHECK, PROOF_CHECK].map((name) => ({
      name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: "neutral",
      external_id: `bootstrap:${name}:${input.headSha}`,
      output: {
        title: "Configuration evidence",
        summary:
          "This check exists so GitHub can offer the Thwip App as the expected source for the " +
          `${name} context. It is not CI and it is not merge verification.`,
      },
    })),
  };
}
