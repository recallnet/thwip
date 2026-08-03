import type { BlockingReason } from "@thwip/queue-domain";

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

/**
 * The three facts about the repository itself, as one read answers them.
 *
 * Named apart from `ReadinessFacts` because they are the subset that costs a
 * GitHub round trip, so a caller can see what it is buying. `sponsorAuthorized`
 * is `ownerAuthorized` under the name the person reading it would use: the
 * sponsor is whose turn it is, and their access is what was revoked.
 */
export interface PlatformHealth {
  readonly rulesetEnforced: boolean;
  readonly appPermissionsHealthy: boolean;
  readonly sponsorAuthorized: boolean;
}

/**
 * Facts nobody has read yet.
 *
 * A caller spreads this and overrides what it knows, so `deriveReadiness` stays
 * one derivation rather than growing a second, narrower copy for every place
 * that holds only part of the picture. That is how the queue ended up with two
 * hand-rolled readiness checks that between them consulted neither the ruleset,
 * nor the App's permissions, nor the sponsor's access.
 *
 * Every value here means "no objection", because an unread fact is not a
 * refusal. A blank that blocked would stop the queue on everything a caller had
 * not got round to reading, which is the opposite failure and a worse one.
 */
export const NO_OBJECTION: ReadinessFacts = {
  projectEnabled: true,
  queuePaused: false,
  managedBaseRef: "",
  pullRequestState: "open",
  draft: false,
  baseRef: "",
  mergeable: null,
  ownerAuthorized: true,
  authorIsBot: false,
  sponsorPrincipalId: null,
  headProof: "accepted",
  activePolicyDigest: null,
  proofPolicyDigest: null,
  reviewsSatisfied: true,
  codeOwnerReviewSatisfied: true,
  approvalAfterPushSatisfied: true,
  conversationsResolved: true,
  nonThwipChecks: "passing",
  appPermissionsHealthy: true,
  rulesetEnforced: true,
  cancelled: false,
  needsRepair: false,
  cooldownUntil: null,
  now: "",
  compatibleRunnerConnected: false,
  serverExecutable: true,
};

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

/**
 * Capability inputs on their own, apart from every other readiness check.
 *
 * `serverExecutable` makes presence irrelevant rather than merely true: a
 * `fast` or `remote` repository has no runners, and must not be gated on one.
 */
export interface CapabilityFacts {
  readonly compatibleRunnerConnected: boolean;
  readonly serverExecutable: boolean;
}

function hasCapability(facts: CapabilityFacts): boolean {
  return facts.serverExecutable || facts.compatibleRunnerConnected;
}

/**
 * Fold capability into an otherwise-decided readiness, without recomputing
 * the other checks.
 *
 * This is the one place `schedulerEligible` is decided from runner presence.
 * Every writer of `schedulerEligible` — `/authorize`, the pull-request
 * webhook, the heartbeat route, and the scheduled tick — calls this rather
 * than each carrying its own copy of "and is a runner connected", which is
 * how eligibility ended up written by whichever of them ran last instead of
 * derived (plan.md §452).
 */
export function foldCapability(
  base: { readonly ready: boolean; readonly primaryReason: BlockingReason | null },
  capability: CapabilityFacts,
): { readonly schedulerEligible: boolean; readonly primaryReason: BlockingReason | null } {
  if (!base.ready) return { schedulerEligible: false, primaryReason: base.primaryReason };
  if (hasCapability(capability)) return { schedulerEligible: true, primaryReason: base.primaryReason };
  // Capability is reported last: an offline machine does not make the entry
  // unready, it only withholds the offer, so this must not override an
  // earlier, more actionable reason — but `base.ready` is true here, so there
  // is no earlier reason to preserve.
  return { schedulerEligible: false, primaryReason: "AGENT_OFFLINE" };
}

export function deriveReadiness(facts: ReadinessFacts): Readiness {
  const blocking = collect(facts);

  // Capability is evaluated independently of every other check — even a
  // blocked entry reports whether a machine is there, so the dashboard can
  // say both things at once — and only ever suppresses scheduling, never
  // readiness itself, so the entry keeps its fairness identity (§7.1, §7.2).
  const capability: BlockingReason[] = hasCapability(facts) ? [] : ["AGENT_OFFLINE"];

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

/** What a branch requires of a head, and what the head says about it. */
export interface RequiredCheckFacts {
  /** Contexts a `required_status_checks` rule names for this branch. */
  readonly required: readonly string[];
  /** The latest run per name on the head. */
  readonly runs: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
}

/**
 * Conclusions GitHub counts as satisfying a required status check.
 *
 * Restated here rather than imported from `github-port.ts`, which is the HTTP
 * port and would drag fetch-shaped code into a pure derivation.
 * `required-checks-before-merge.test.ts` asserts the two readings agree on
 * every conclusion, so they cannot drift.
 */
const SATISFYING = new Set(["success", "neutral", "skipped"]);

/** A context this queue publishes itself: `thwip` and everything under it. */
function ownCheck(context: string): boolean {
  return context === "thwip" || context.startsWith("thwip / ");
}

/**
 * `nonThwipChecks`, from the branch rules and the runs on the head.
 *
 * This fact had no writer. Every caller of `deriveReadiness` spread
 * `NO_OBJECTION`, whose default is `"passing"`, so `REQUIRED_CHECK_FAILED` and
 * `REQUIRED_CHECK_PENDING` could not be produced by the derivation at all: a
 * pull request whose CI had gone red read as ready, took a turn, ran it on a
 * developer's machine, and the walk to the merge refused it on the same fact
 * that was readable before the offer.
 *
 * The queue's own checks are skipped, which is what the name says. `thwip /
 * turn` is required on the branch and published by the queue from the outcome
 * of this derivation, so counting it would wire readiness to itself: pending
 * turn check, unready entry, no offer, no turn check.
 *
 * A required context with no run at all is left as passing. `A required check
 * is still running` would be a false statement about a context nothing has
 * started, and the merge gate already refuses that case by name, on the same
 * GitHub answer, a moment before the write.
 */
export function nonThwipCheckState(facts: RequiredCheckFacts): "passing" | "pending" | "failing" {
  let pending = false;
  for (const context of facts.required) {
    if (ownCheck(context)) continue;
    const runs = facts.runs.filter((run) => run.name === context);
    if (runs.length === 0) continue;
    if (runs.some((run) => run.status === "completed" && SATISFYING.has(run.conclusion ?? ""))) continue;
    // Still running may yet pass, so it waits rather than refuses. A failure is
    // reported ahead of it because it is the one a developer can act on.
    if (runs.some((run) => run.status !== "completed")) {
      pending = true;
      continue;
    }
    return "failing";
  }
  return pending ? "pending" : "passing";
}
