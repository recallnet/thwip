import type { BlockingReason } from "@thwip/queue-domain";
import { TURN_CHECK } from "./turn-check.js";

/**
 * Deriving readiness (plan.md §7.1).
 *
 * A queue request is durable; readiness is not. It is a conjunction of many
 * current facts, so it is re-derived from scratch on every relevant GitHub event
 * rather than patched from the event's contents: an event says what changed, not
 * whether everything else still holds.
 *
 * The order of checks is deliberate. The reason a developer sees should be the
 * most actionable one, so repository-level problems come before review problems.
 * Capability is not here at all; `foldCapability` decides it, after everything
 * else, because an offline laptop keeps its place and must not freeze the branch.
 */

/**
 * A fact this caller could not read.
 *
 * Every field below is required, and a caller that cannot answer one says so
 * instead of writing a value that reads as fine. `collect` turns `"unread"` into
 * no objection in one place, so an unread fact never refuses, but a reviewer can
 * still tell a caller that read the fact from a caller that skipped it.
 *
 * This replaced a permissive constant every call site spread. The constant meant
 * a field nobody thought about was silently "no problem": seventeen of
 * twenty-four fields held their default forever, and thirteen reason codes with
 * sentences on every surface described states nothing ever checked for. The
 * spread was the defect, so the spread is gone and every field is required. A
 * twenty-fifth field breaks all three call sites until someone decides what it
 * means there.
 */
export type Unread = "unread";

export interface ReadinessFacts {
  /* Pull request */
  readonly draft: boolean;

  /* Authorization */
  readonly ownerAuthorized: boolean | Unread;
  readonly authorIsBot: boolean | Unread;
  readonly sponsorPrincipalId: string | null;

  /* Evidence */
  readonly headProof: "accepted" | "missing" | "rejected" | Unread;
  /**
   * What the head's proof does not cover of the policy in force, from
   * `proofShortfall`, or null when it covers all of it.
   *
   * Not a pair of policy digests. Identity was the wrong comparison and was
   * removed from the verifier and the merge gate: a policy's digest moves when
   * a setting no proof can fail moves, so refusing on it invalidated every
   * proof in flight over a cosmetic edit.
   */
  readonly proofShortfall: string | null | Unread;

  /* GitHub's own gates */
  readonly reviewsSatisfied: boolean | Unread;
  readonly codeOwnerReviewSatisfied: boolean | Unread;
  readonly approvalAfterPushSatisfied: boolean | Unread;
  readonly conversationsResolved: boolean | Unread;
  readonly nonThwipChecks: "passing" | "pending" | "failing" | Unread;
  readonly mergeable: boolean | null | Unread;

  /* Platform health */
  readonly appPermissionsHealthy: boolean | Unread;
  readonly rulesetEnforced: boolean | Unread;
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

export interface Readiness {
  readonly ready: boolean;
  readonly primaryReason: BlockingReason | null;
  readonly secondaryReasons: readonly BlockingReason[];
}

/** Every check, in the order a developer would want to hear about them. */
function collect(facts: ReadinessFacts): BlockingReason[] {
  // Unread facts, resolved once, here and nowhere else.
  //
  // A fact nobody has read is not a refusal. A blank that blocked would stop the
  // queue on everything a caller had not got round to reading, which is the
  // opposite failure and the worse one. Only an explicit negative objects.
  const ownerAuthorized = facts.ownerAuthorized !== false;
  const appPermissionsHealthy = facts.appPermissionsHealthy !== false;
  const rulesetEnforced = facts.rulesetEnforced !== false;
  const reviewsSatisfied = facts.reviewsSatisfied !== false;
  const codeOwnerReviewSatisfied = facts.codeOwnerReviewSatisfied !== false;
  const approvalAfterPushSatisfied = facts.approvalAfterPushSatisfied !== false;
  const conversationsResolved = facts.conversationsResolved !== false;
  const proofShortfall = facts.proofShortfall === "unread" ? null : facts.proofShortfall;

  const reasons: BlockingReason[] = [];

  // A closed pull request is not a readiness fact. The `pull_request` webhook
  // cancels its entry outright, which frees the lane rather than leaving a
  // blocked entry holding it, and the walk to a merge hears `PR_CLOSED` from
  // GitHub's own answer about the candidate. The field that used to sit here
  // had exactly one writer, and that writer now returns before it is read.
  if (facts.draft) reasons.push("PR_DRAFT");
  if (!ownerAuthorized) reasons.push("OWNER_UNAUTHORIZED");
  // A bot pull request cannot consume a fairness share without a human behind
  // it. The human who joins becomes the sponsor, so this clears by somebody
  // queueing the pull request rather than by anything the bot can do.
  if (facts.authorIsBot === true && facts.sponsorPrincipalId === null) reasons.push("SPONSOR_REQUIRED");

  if (!appPermissionsHealthy) reasons.push("APP_PERMISSION_DRIFT");
  if (!rulesetEnforced) reasons.push("RULESET_DRIFT");

  if (facts.headProof === "missing") reasons.push("LOCAL_RECEIPT_MISSING");
  if (facts.headProof === "rejected") reasons.push("LOCAL_RECEIPT_REJECTED");
  // The active policy judges the work, never the policy the pull request
  // proposes (plan.md §6.2 invariant 14). What it judges is the pipeline and
  // the required suites, which `proofShortfall` compares with the same two
  // tests the merge gate uses. The merge gate refuses this after the pull
  // request has spent its turn; here it is refused before the offer goes out.
  if (facts.headProof === "accepted" && proofShortfall !== null) reasons.push("POLICY_CHANGED");

  if (!reviewsSatisfied) reasons.push("REVIEW_REQUIRED");
  if (!codeOwnerReviewSatisfied) reasons.push("CODEOWNER_REVIEW_REQUIRED");
  if (!approvalAfterPushSatisfied) reasons.push("APPROVAL_AFTER_PUSH_REQUIRED");
  if (!conversationsResolved) reasons.push("CONVERSATION_UNRESOLVED");
  if (facts.nonThwipChecks === "failing") reasons.push("REQUIRED_CHECK_FAILED");
  if (facts.nonThwipChecks === "pending") reasons.push("REQUIRED_CHECK_PENDING");

  // `mergeable: null` means GitHub has not finished computing it. That is not a
  // conflict, and reporting one would be wrong.
  if (facts.mergeable === false) reasons.push("MERGE_CONFLICT");

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
 * Fold capability into an otherwise-decided readiness.
 *
 * This is the one place `schedulerEligible` is decided from runner presence.
 * Every writer of it — `/authorize`, the pull-request webhook, the heartbeat
 * route, and the scheduled tick — calls this rather than each carrying its own
 * copy of "and is a runner connected", which is how eligibility ended up
 * written by whichever of them ran last instead of derived (plan.md §452).
 *
 * `deriveReadiness` used to answer the same question a second time, off two
 * fields sitting inside `ReadinessFacts`. Those fields are gone and the answer
 * is here alone, so the two cannot disagree.
 */
export function foldCapability(
  base: { readonly ready: boolean; readonly primaryReason: BlockingReason | null },
  capability: CapabilityFacts,
): { readonly schedulerEligible: boolean; readonly primaryReason: BlockingReason | null } {
  if (!base.ready) return { schedulerEligible: false, primaryReason: base.primaryReason };
  if (hasCapability(capability)) return { schedulerEligible: true, primaryReason: base.primaryReason };
  // Capability is reported last: an offline machine does not make the entry
  // unready, it only withholds the offer, so this must not override an
  // earlier, more actionable reason. `base.ready` is true here, so there is no
  // earlier reason to preserve.
  return { schedulerEligible: false, primaryReason: "AGENT_OFFLINE" };
}

export function deriveReadiness(facts: ReadinessFacts): Readiness {
  const blocking = collect(facts);
  const deduped = blocking.filter((reason, i) => blocking.indexOf(reason) === i);

  return {
    ready: deduped.length === 0,
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

/**
 * The one context readiness must not read: its own output.
 *
 * `thwip / turn` is what this derivation publishes, so counting it would make
 * readiness depend on the last thing readiness said.
 *
 * `thwip` is excluded from that reasoning on purpose. It is the App's verdict on
 * the head's proof, published by proof verification and not by this file, so
 * reading it is not circular. It used to be skipped alongside the turn check,
 * which meant a red proof check left an entry ready: the queue offered the lane
 * to a pull request whose proof the App had already rejected, and the merge gate
 * refused it at the end instead.
 */
function ownCheck(context: string): boolean {
  return context === TURN_CHECK;
}

/**
 * `nonThwipChecks`, from the branch rules and the runs on the head.
 *
 * This fact had no writer. Every caller spread a permissive constant whose
 * default was `"passing"`, so `REQUIRED_CHECK_FAILED` and
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

/**
 * What the branch's `pull_request` rule asks of a pull request, and what GitHub
 * says about this one.
 *
 * Both halves are needed. The rule says which of the four gates apply, because a
 * branch that does not require a code owner must not be told one is missing; the
 * pull request says whether the ones that apply are met.
 */
export interface ReviewFacts {
  /** From the branch's `pull_request` rule. Zero when the branch has no such rule. */
  readonly requiredApprovingReviewCount: number;
  readonly requireCodeOwnerReview: boolean;
  readonly requireLastPushApproval: boolean;
  readonly requireThreadResolution: boolean;
  /**
   * GitHub's own decision about this pull request under those rules.
   *
   * Null when nothing is required of it. This is the only thing that refuses:
   * the rules can be satisfied by reviewers the queue cannot enumerate, so
   * counting approvals here would refuse merges GitHub would allow.
   */
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  /** A review CODEOWNERS asked for and nobody has given. */
  readonly pendingCodeOwnerReview: boolean;
  /** Approving reviews, and how many of them name the current head commit. */
  readonly approvals: number;
  readonly approvalsOnHead: number;
  /** Open review threads that still apply to the head. */
  readonly unresolvedThreads: number;
}

/**
 * What one read of a pull request answers.
 *
 * Five facts, one round trip, taken at the point the required checks are
 * already read. Mergeability rides along because it comes from the same
 * response: `MERGE_CONFLICT` was unreachable for the same reason the four
 * review gates were, and a conflicted pull request otherwise spends a turn
 * before anything says so.
 */
export interface PullRequestGates {
  readonly review: ReviewFacts;
  readonly mergeable: boolean | null;
}

/** The four review gates, as `ReadinessFacts` states them. */
export interface ReviewGates {
  readonly reviewsSatisfied: boolean;
  readonly codeOwnerReviewSatisfied: boolean;
  readonly approvalAfterPushSatisfied: boolean;
  readonly conversationsResolved: boolean;
}

/**
 * The four review gates, from one read of the branch rules and the pull request.
 *
 * GitHub enforces all four and only GitHub, at the ref update the App performs.
 * Nothing in the control plane read a review, so a pull request with
 * no approval was called ready, given the lane ahead of everyone waiting, run
 * through the full pipeline on a developer's machine, and handed a signed
 * merge-intent attestation for a merge GitHub was never going to permit. The
 * 422 arrived after all of that, after the queue had already spent the turn.
 *
 * Nothing here refuses on its own arithmetic. A refusal needs GitHub to have
 * already said `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, or a required thread
 * left open. The three approval codes then name which rule is unmet, because
 * "a code owner has to look at this" and "approve it again after that push"
 * send a developer to different places.
 */
export function reviewGates(facts: ReviewFacts): ReviewGates {
  const satisfied: ReviewGates = {
    reviewsSatisfied: true,
    codeOwnerReviewSatisfied: true,
    approvalAfterPushSatisfied: true,
    conversationsResolved: !facts.requireThreadResolution || facts.unresolvedThreads === 0,
  };

  // No approval rule on this branch, so none of the three approval codes can be
  // true of it. A `reviewDecision` arriving from something the rules endpoint
  // does not report must not refuse a merge on a rule the queue cannot see.
  const approvalRule = facts.requiredApprovingReviewCount > 0 || facts.requireCodeOwnerReview;
  const settled = facts.reviewDecision === "APPROVED" || facts.reviewDecision === null;
  if (!approvalRule || settled) return satisfied;

  // Changes requested is the reviewer speaking, not a rule going unmet, so the
  // three rule-specific codes would name the wrong thing.
  if (facts.reviewDecision === "CHANGES_REQUESTED") {
    return { ...satisfied, reviewsSatisfied: false };
  }

  if (facts.requireCodeOwnerReview && facts.pendingCodeOwnerReview) {
    return { ...satisfied, codeOwnerReviewSatisfied: false };
  }
  // Somebody approved and then the branch moved. Saying "this needs a review"
  // to a developer who is looking at an approval is how they stop believing the
  // check.
  if (facts.requireLastPushApproval && facts.approvals > 0 && facts.approvalsOnHead === 0) {
    return { ...satisfied, approvalAfterPushSatisfied: false };
  }
  return { ...satisfied, reviewsSatisfied: false };
}
