import type { BlockingReason } from "@thwip/queue-domain";
import { THWIP_MERGE_CONTEXT } from "./rulesets.js";

/**
 * The `Thwip / Merge` check (plan.md §17.2, §29.1).
 *
 * The App publishes it so its source can be pinned, which is what stops any
 * workflow from satisfying the gate. Its content has one job: tell a developer
 * looking at a red check exactly what to do next, without making them read a log.
 *
 * Activation state matters here. In `observe` the check reports what the queue
 * would have done and always concludes neutral, so a repository can adopt the
 * queue beside its existing gate without the queue being able to block anything.
 * Only in `enforced` does a conclusion gate a merge.
 */

export type ActivationState = "configured" | "observe" | "canary" | "enforced";

export type CheckConclusion = "success" | "failure" | "neutral";

export interface CheckContent {
  readonly name: typeof THWIP_MERGE_CONTEXT;
  readonly conclusion: CheckConclusion;
  readonly title: string;
  readonly summary: string;
  readonly externalId: string;
}

export interface QueueCheckState {
  readonly activationState: ActivationState;
  readonly entryState: string;
  readonly primaryReason: string | null;
  readonly secondaryReasons?: readonly string[];
  readonly schedulerEligible: boolean;
  readonly projectedPosition: number | null;
  readonly totalReady: number;
  readonly attemptId: string | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly cooldownUntil: string | null;
}

/**
 * Plain-language next actions for every blocking reason.
 *
 * Keyed by the domain's own union, so adding a reason without writing its
 * sentence fails to compile. It used to be keyed by string, and a reason with
 * no entry fell through to "Blocked: MERGE_REJECTED.", which is a code shown to
 * a person, not an instruction.
 */
const NEXT_ACTION: Record<BlockingReason, string> = {
  REVIEW_REQUIRED: "Ask for a review. The queue holds your place while you wait.",
  CODEOWNER_REVIEW_REQUIRED: "A code owner for the files you touched still needs to approve.",
  APPROVAL_AFTER_PUSH_REQUIRED: "You pushed after the last approval, so it needs approving again.",
  CONVERSATION_UNRESOLVED: "Resolve the open review conversations.",
  REQUIRED_CHECK_PENDING: "A required check is still running.",
  REQUIRED_CHECK_FAILED: "A required check failed. Fix it and push again; your place is kept.",
  VERIFICATION_REJECTED:
    "The verifier refused this candidate. Run thwip verify to see why; your place is kept.",
  MERGE_CONFLICT: "Rebase or merge the base branch to clear the conflict.",
  LOCAL_RECEIPT_MISSING: "Run thwip run on this commit and push, so the head carries a proof.",
  LOCAL_RECEIPT_REJECTED: "The proof on this commit was not accepted. thwip verify explains why.",
  AGENT_OFFLINE:
    "No machine of yours is connected to run the integration. Start thwip ship, or leave it queued and it will be offered again.",
  NO_COMPATIBLE_RUNNER: "No connected machine can run this project's pipeline.",
  PR_DRAFT: "Mark the pull request ready for review.",
  PR_CLOSED: "The pull request is closed.",
  BASE_NOT_MANAGED:
    "This pull request targets a branch the queue does not manage. Retarget it, or ask an admin to enable the queue for that branch.",
  OWNER_UNAUTHORIZED: "You no longer have the repository permission this queue requires.",
  SPONSOR_REQUIRED: "A bot pull request needs a human sponsor before it can queue.",
  COOLDOWN_ACTIVE: "A turn was offered and not claimed, so there is a short cooldown before the next one.",
  NEEDS_REPAIR: "The integration failed. Push a fix; your place in line is kept.",
  POLICY_CHANGED: "The project policy changed. The queue will re-evaluate on the new policy.",
  RULESET_DRIFT: "The repository ruleset no longer matches what the queue expects. An admin needs to look.",
  APP_PERMISSION_DRIFT: "The Thwip App is missing a permission it needs. An admin needs to reinstall it.",
  PROJECT_DISABLED: "This project is not enabled for the queue.",
  QUEUE_PAUSED: "The queue is paused.",
  MERGE_REJECTED: "GitHub refused the merge. Read the branch protection rules on the base branch.",
  MERGE_OUTCOME_UNKNOWN:
    "The queue cannot tell whether the merge landed. It is reconciling and will not write again. Check the pull request before doing anything.",
  ADMIN_CANCELLED: "An administrator cancelled this attempt. Ask them why before queueing again.",
  INTERNAL_FAILURE: "The queue failed internally. Send this output to whoever runs the queue.",
};

export function nextAction(reason: string | null): string | null {
  if (reason === null) return null;
  return NEXT_ACTION[reason as BlockingReason] ?? `Blocked: ${reason}.`;
}

/**
 * Projected order, never an exact permanent position. Readiness changes after
 * every GitHub event, so a promised position would be a lie (plan.md §8.3).
 */
function positionLine(state: QueueCheckState): string {
  if (!state.schedulerEligible) return "Not currently schedulable, but holding its place in line.";
  if (state.projectedPosition === null) return "Waiting for the scheduler.";
  return `Projected order: ${state.projectedPosition} of ${state.totalReady} ready. This changes as reviews and checks change.`;
}

export function buildCheck(state: QueueCheckState, headSha: string): CheckContent {
  const externalId =
    state.attemptId === null ? `entry:${headSha}` : `attempt:${state.attemptId}`;

  // Observe never gates. It reports the same reasoning so a team can see what the
  // queue would have done before letting it decide anything.
  const observing = state.activationState === "observe" || state.activationState === "configured";

  if (state.paused) {
    return {
      name: THWIP_MERGE_CONTEXT,
      conclusion: observing ? "neutral" : "failure",
      title: "Queue paused",
      summary: [
        `The queue for this branch is paused${state.pauseReason === null ? "" : `: ${state.pauseReason}`}.`,
        state.pauseReason === "EXTERNAL_TRANSITION"
          ? "The branch moved outside the queue, so an administrator has to rebaseline before merging resumes."
          : "An administrator can resume it.",
        observing ? "" : "Nothing merges through the queue while it is paused.",
      ]
        .filter((line) => line !== "")
        .join("\n\n"),
      externalId,
    };
  }

  if (state.entryState === "Merged") {
    return {
      name: THWIP_MERGE_CONTEXT,
      conclusion: "success",
      title: "Merged by the queue",
      summary: "This pull request was integrated and merged by Thwip Queue.",
      externalId,
    };
  }

  if (state.entryState === "Cancelled") {
    return {
      name: THWIP_MERGE_CONTEXT,
      conclusion: observing ? "neutral" : "failure",
      title: "Removed from the queue",
      summary: "This entry was withdrawn or ejected. Queue it again when it is ready.",
      externalId,
    };
  }

  const active = ["Offered", "Active", "ReconnectGrace", "Verifying", "MergeGuard", "Merging", "Reconciling"];
  if (active.includes(state.entryState)) {
    return {
      name: THWIP_MERGE_CONTEXT,
      conclusion: "neutral",
      title: `Integrating (${state.entryState})`,
      summary: [
        "This pull request holds the queue's lane and is being integrated against the current base.",
        state.entryState === "Reconciling"
          ? "The merge result is being reconciled. Nothing will be written again until it is resolved."
          : "The check turns green once the integration is verified and merged.",
      ].join("\n\n"),
      externalId,
    };
  }

  const action = nextAction(state.primaryReason);
  if (state.entryState === "Ready" || state.primaryReason === null) {
    return {
      name: THWIP_MERGE_CONTEXT,
      conclusion: "neutral",
      title: "Queued",
      summary: [positionLine(state), "Nothing is required from you; the queue will offer a turn."]
        .join("\n\n"),
      externalId,
    };
  }

  const secondary = (state.secondaryReasons ?? []).filter((r) => r !== state.primaryReason);
  return {
    name: THWIP_MERGE_CONTEXT,
    conclusion: observing ? "neutral" : "failure",
    title: titleFor(state.primaryReason),
    summary: [
      action ?? "This entry is not ready.",
      secondary.length === 0 ? "" : `Also waiting on: ${secondary.join(", ")}.`,
      state.cooldownUntil === null ? "" : `Next turn possible after ${state.cooldownUntil}.`,
      "Your place in line is kept while this is unresolved.",
    ]
      .filter((line) => line !== "")
      .join("\n\n"),
    externalId,
  };
}

function titleFor(reason: string): string {
  switch (reason) {
    case "AGENT_OFFLINE":
    case "NO_COMPATIBLE_RUNNER":
      return "Waiting for a machine";
    case "REVIEW_REQUIRED":
    case "CODEOWNER_REVIEW_REQUIRED":
    case "APPROVAL_AFTER_PUSH_REQUIRED":
      return "Waiting for review";
    case "MERGE_CONFLICT":
      return "Conflict with the base branch";
    case "REQUIRED_CHECK_FAILED":
      return "A required check failed";
    case "VERIFICATION_REJECTED":
      return "The verifier refused the candidate";
    case "REQUIRED_CHECK_PENDING":
      return "Waiting for a required check";
    case "LOCAL_RECEIPT_MISSING":
    case "LOCAL_RECEIPT_REJECTED":
      return "No accepted proof on this commit";
    default:
      return "Not ready to merge";
  }
}

/**
 * Whether a conclusion may gate a merge at all. In `observe` the queue is
 * deliberately incapable of blocking, which is what makes adoption reversible
 * (plan.md §4.8).
 */
export function mayGate(activationState: ActivationState): boolean {
  return activationState === "canary" || activationState === "enforced";
}
