import { BLOCKING_REASONS, isCapabilityReason, type BlockingReason } from "@thwip/queue-domain";

/**
 * Deriving readiness (plan.md §7.1).
 *
 * A queue request is durable; readiness is not. It is a conjunction of many
 * current facts, so it is re-derived from scratch on every relevant GitHub event
 * rather than patched from the event's contents — an event says what changed,
 * not whether everything else still holds.
 *
 * The order of checks is deliberate. The reason a developer sees should be the
 * most actionable one, so repository-level problems come before review problems,
 * and review problems before "no machine is connected". A capability problem is
 * reported last because it does not make the entry unready: an offline laptop
 * keeps its place and must not freeze the branch.
 */

export interface ReadinessFacts {
  /* Project and queue configuration */
  readonly projectEnabled: boolean;
  readonly queuePaused: boolean;
  readonly managedBaseRef: string;

  /* Pull request */
  readonly pullRequestState: "open" | "closed";
  readonly draft: boolean;
  readonly baseRef: string;
  readonly mergeable: boolean | null;

  /* Authorization */
  readonly ownerAuthorized: boolean;
  readonly authorIsBot: boolean;
  readonly sponsorPrincipalId: string | null;

  /* Evidence */
  readonly headProof: "accepted" | "missing" | "rejected";
  readonly activePolicyDigest: string | null;
  readonly proofPolicyDigest: string | null;

  /* GitHub's own gates */
  readonly reviewsSatisfied: boolean;
  readonly codeOwnerReviewSatisfied: boolean;
  readonly approvalAfterPushSatisfied: boolean;
  readonly conversationsResolved: boolean;
  readonly nonThwipChecks: "passing" | "pending" | "failing";

  /* Platform health */
  readonly appPermissionsHealthy: boolean;
  readonly rulesetEnforced: boolean;

  /* Entry lifecycle */
  readonly cancelled: boolean;
  readonly needsRepair: boolean;
  readonly cooldownUntil: string | null;
  readonly now: string;

  /* Ephemeral capability, not repository readiness */
  readonly compatibleRunnerConnected: boolean;
  /** Fast reuse or remote execution means no device is needed at all. */
  readonly serverExecutable: boolean;
}

export interface Readiness {
  readonly ready: boolean;
  readonly schedulerEligible: boolean;
  readonly primaryReason: BlockingReason | null;
  readonly secondaryReasons: readonly BlockingReason[];
}

/** Every check, in the order a developer would want to hear about them. */
function collect(facts: ReadinessFacts): BlockingReason[] {
  const reasons: BlockingReason[] = [];

  if (!facts.projectEnabled) reasons.push("PROJECT_DISABLED");
  if (facts.queuePaused) reasons.push("QUEUE_PAUSED");
  if (facts.cancelled) reasons.push("PR_CLOSED");
  if (facts.pullRequestState === "closed") reasons.push("PR_CLOSED");
  if (facts.draft) reasons.push("PR_DRAFT");
  if (facts.baseRef !== facts.managedBaseRef) reasons.push("BASE_NOT_MANAGED");
  if (!facts.ownerAuthorized) reasons.push("OWNER_UNAUTHORIZED");
  // A bot pull request cannot consume a fairness share without a human behind it.
  if (facts.authorIsBot && facts.sponsorPrincipalId === null) reasons.push("SPONSOR_REQUIRED");

  if (!facts.appPermissionsHealthy) reasons.push("APP_PERMISSION_DRIFT");
  if (!facts.rulesetEnforced) reasons.push("RULESET_DRIFT");

  if (facts.headProof === "missing") reasons.push("LOCAL_RECEIPT_MISSING");
  if (facts.headProof === "rejected") reasons.push("LOCAL_RECEIPT_REJECTED");
  // The active policy judges the work, never the policy the pull request proposes
  // (plan.md §6.2 invariant 14).
  if (
    facts.headProof === "accepted" &&
    facts.activePolicyDigest !== null &&
    facts.proofPolicyDigest !== null &&
    facts.proofPolicyDigest !== facts.activePolicyDigest
  ) {
    reasons.push("POLICY_CHANGED");
  }

  if (!facts.reviewsSatisfied) reasons.push("REVIEW_REQUIRED");
  if (!facts.codeOwnerReviewSatisfied) reasons.push("CODEOWNER_REVIEW_REQUIRED");
  if (!facts.approvalAfterPushSatisfied) reasons.push("APPROVAL_AFTER_PUSH_REQUIRED");
  if (!facts.conversationsResolved) reasons.push("CONVERSATION_UNRESOLVED");
  if (facts.nonThwipChecks === "failing") reasons.push("REQUIRED_CHECK_FAILED");
  if (facts.nonThwipChecks === "pending") reasons.push("REQUIRED_CHECK_PENDING");

  // `mergeable: null` means GitHub has not finished computing it. That is not a
  // conflict, and reporting one would be wrong.
  if (facts.mergeable === false) reasons.push("MERGE_CONFLICT");

  if (facts.needsRepair) reasons.push("NEEDS_REPAIR");
  if (facts.cooldownUntil !== null && facts.cooldownUntil > facts.now) reasons.push("COOLDOWN_ACTIVE");

  return reasons;
}

export function deriveReadiness(facts: ReadinessFacts): Readiness {
  const blocking = collect(facts);

  // Capability is evaluated separately: it suppresses scheduling without making
  // the entry unready, so the entry keeps its fairness identity (§7.1, §7.2).
  const capability: BlockingReason[] = [];
  if (!facts.serverExecutable && !facts.compatibleRunnerConnected) capability.push("AGENT_OFFLINE");

  const ready = blocking.length === 0;
  const schedulerEligible = ready && capability.length === 0;

  const ordered = [...blocking, ...capability];
  const deduped = ordered.filter((reason, i) => ordered.indexOf(reason) === i);

  return {
    ready,
    schedulerEligible,
    primaryReason: deduped[0] ?? null,
    secondaryReasons: deduped.slice(1),
  };
}

/**
 * A readiness result is only useful if its reason is one the check and the
 * dashboard know how to explain. This guards against a typo becoming a bare code
 * in front of a developer.
 */
export function isKnownReason(reason: string): reason is BlockingReason {
  return (BLOCKING_REASONS as readonly string[]).includes(reason);
}

/** True when the only thing standing in the way is an absent machine. */
export function blockedOnlyByCapability(readiness: Readiness): boolean {
  return (
    readiness.ready &&
    !readiness.schedulerEligible &&
    readiness.primaryReason !== null &&
    isCapabilityReason(readiness.primaryReason)
  );
}
