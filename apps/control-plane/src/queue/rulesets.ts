/**
 * Ruleset generation for the managed and native backends (plan.md §44).
 *
 * Two rules govern everything here. Unrelated controls are merged, never
 * replaced: a generated payload that dropped someone's existing protection would
 * be a security regression delivered by a setup tool. And a managed ownership
 * rule must never reach a native branch, nor a native merge-queue rule a managed
 * one, because each would hand the branch to the wrong writer.
 */

import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";

export type Backend = "managed" | "native";
export type MergeMethod = "merge" | "squash";

/**
 * A context this generator once required and nothing has ever published.
 *
 * plan.md §44 names one App-published gate, `Thwip / Merge`. The queue that got
 * built publishes two checks and neither is called that: `thwip / turn` from the
 * App, and `thwip` from the workflow in `.github/workflows/thwip-required.yml`.
 * A repository provisioned from the old generator required a check no source
 * would ever post, so its branch could not merge and no amount of waiting would
 * change that.
 *
 * Kept exported because `check.ts` and `github-port.ts` still name it. Nothing
 * requires it, and nothing should start.
 */
export const THWIP_MERGE_CONTEXT = "Thwip / Merge" as const;

/**
 * GitHub Actions' own Integration id, which is the same everywhere.
 *
 * The proof check is published by a workflow, so GitHub attributes it to Actions
 * rather than to the Thwip App, and pinning it to the App's id would produce a
 * requirement the workflow can never satisfy. Read off the live ruleset on
 * `recallnet/thwip`, where `thwip` is pinned to 15368 and `thwip / turn` to the
 * App.
 */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

export const OWNERSHIP_RULESET_NAME = "Thwip Queue Ownership" as const;
export const POLICY_RULESET_NAME = "Thwip Repository Policy" as const;

export interface RulesetRule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

export interface Ruleset {
  readonly name: string;
  readonly target: "branch";
  readonly enforcement: "active" | "disabled";
  readonly bypass_actors: ReadonlyArray<Record<string, unknown>>;
  readonly conditions: { readonly ref_name: { readonly include: readonly string[]; readonly exclude: readonly string[] } };
  readonly rules: readonly RulesetRule[];
}

export interface PolicyOptions {
  readonly baseRef: string;
  /** The Thwip App, which publishes the turn check. */
  readonly integrationId: number;
  /** GitHub Actions, which publishes the proof check. Defaulted, never guessed. */
  readonly actionsIntegrationId?: number;
  readonly mergeMethod: MergeMethod;
  readonly requiredApprovingReviewCount: number;
  readonly requireCodeOwnerReview: boolean;
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
 * Only the Thwip App may update a managed branch, because the App performs the
 * merge. Deletion and force-push stay blocked for everyone.
 */
export function managedOwnershipRuleset(input: { baseRef: string; integrationId: number }): Ruleset {
  return {
    name: OWNERSHIP_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [
      { actor_id: input.integrationId, actor_type: "Integration", bypass_mode: "pull_request" },
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
 * The repository policy: review requirements plus the two checks the queue
 * actually publishes.
 *
 * `thwip` answers whether the proof is good for this tree and comes out of the
 * repository's own workflow, so GitHub Actions is its source. `thwip / turn`
 * answers whose turn it is and is published by the App the moment it offers the
 * lane, so the App is its source. They have different sources because they have
 * different publishers, and one shared `integration_id` would make one of them
 * unsatisfiable.
 *
 * Existing required checks are carried through, deduplicated by context, with
 * the caller's own source pin winning for the two Thwip contexts only.
 */
export function policyRuleset(input: PolicyOptions): Ruleset {
  const actionsIntegrationId = input.actionsIntegrationId ?? GITHUB_ACTIONS_INTEGRATION_ID;
  const thwipContexts = new Set<string>([PROOF_CHECK, TURN_CHECK]);
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
    merged.push({ context: PROOF_CHECK }, { context: TURN_CHECK });
  } else {
    merged.push(
      { context: PROOF_CHECK, integration_id: actionsIntegrationId },
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
        type: "pull_request",
        parameters: {
          allowed_merge_methods: [input.mergeMethod],
          required_approving_review_count: input.requiredApprovingReviewCount,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: input.requireCodeOwnerReview,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
        },
      },
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

export interface NativeQueueOptions {
  readonly baseRef: string;
  readonly integrationId: number;
  readonly mergeMethod: MergeMethod;
  /** Must exceed the longest turn plus verifier and reconciliation allowance. */
  readonly checkResponseTimeoutMinutes: number;
}

/**
 * The native adapter keeps GitHub's queue as the writer, so it must not carry
 * the managed ownership rule. Group size is one: Thwip admits exactly one
 * selection at a time, and speculative batching is not in v1.
 */
export function nativeMergeQueueRuleset(input: NativeQueueOptions): Ruleset {
  return {
    name: "Thwip Native Merge Queue",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: refCondition(input.baseRef),
    rules: [
      {
        type: "merge_queue",
        parameters: {
          check_response_timeout_minutes: input.checkResponseTimeoutMinutes,
          grouping_strategy: "ALLGREEN",
          max_entries_to_build: 1,
          max_entries_to_merge: 1,
          merge_method: input.mergeMethod.toUpperCase(),
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: 0,
        },
      },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  };
}

/** Guard against sending a backend's rules to the wrong kind of branch (§44.2). */
export type BackendCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkRulesetForBackend(ruleset: Ruleset, backend: Backend): BackendCheck {
  const types = new Set(ruleset.rules.map((rule) => rule.type));
  if (backend === "native") {
    if (ruleset.name === OWNERSHIP_RULESET_NAME || types.has("update")) {
      return { ok: false, reason: "a native branch is updated by GitHub's queue, not by the Thwip App" };
    }
  } else if (types.has("merge_queue")) {
    return { ok: false, reason: "a managed branch must not carry GitHub's merge_queue rule" };
  }
  return { ok: true };
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

  // Dropping a protection is the outcome this diff exists to make visible.
  for (const rule of removedRules) warnings.push(`this would remove the ${rule} rule`);
  for (const check of removedRequiredChecks) warnings.push(`this would stop requiring ${check}`);
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
  "activate-policy-and-ownership",
  "record-genesis",
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
  ];
  for (const step of required) {
    if (progress[step] !== true) return { ok: false, reason: `${step} has not been completed` };
  }
  return { ok: true };
}

/**
 * The bootstrap check is configuration evidence, not a verdict. It may be
 * neutral only while the policy is disabled, and it is never copied into an
 * attempt or a certificate (§44.3).
 *
 * It names `thwip / turn` because that is the App's context. GitHub will only
 * offer an App as the expected source of a context the App has recently posted,
 * and the App posts the turn check. The proof check gets its source the ordinary
 * way: the setup pull request adds the workflow, and the workflow runs.
 */
export function bootstrapCheckRun(input: { headSha: string; policyEnforcement: "active" | "disabled" }):
  | { readonly ok: true; readonly checkRun: { name: string; head_sha: string; status: string; conclusion: string; external_id: string; output: { title: string; summary: string } } }
  | { readonly ok: false; readonly reason: string } {
  if (input.policyEnforcement !== "disabled") {
    return { ok: false, reason: "a bootstrap check may only be published while the policy is disabled" };
  }
  return {
    ok: true,
    checkRun: {
      name: TURN_CHECK,
      head_sha: input.headSha,
      status: "completed",
      conclusion: "neutral",
      external_id: `bootstrap:${input.headSha}`,
      output: {
        title: "Configuration evidence",
        summary:
          "This check exists so GitHub can offer the Thwip App as the expected source for the " +
          `${TURN_CHECK} context. It is not CI and it is not merge verification.`,
      },
    },
  };
}

export function isBootstrapCheck(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith("bootstrap:");
}
