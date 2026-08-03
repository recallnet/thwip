import { appProofTaskFromWebhook, type AppProofTask } from "./app-proof-verification.js";
import { policyPushFromGithubWebhook, type PolicyPush } from "./policy-activation.js";

/**
 * Whether a webhook delivery is worth a queue operation.
 *
 * Every delivery used to buy one, and the consumer then synced the whole
 * installation for it. The App publishes six checks per commit and GitHub fires
 * a check_run webhook for each, so the App billed itself for its own output.
 * That drained a day's Queues budget, and the budget is what the five minute
 * cron runs on, so the machinery that settles orphaned merge writes and verifies
 * the chain went down first.
 *
 * The rule here is the consumer's own list of branches. Anything the consumer
 * would act on is enqueued. Anything else costs nothing, because a queue
 * operation that does no work is still an operation.
 */

/** Events after which the consumer's reconcile pass has something to reconcile. */
export const MEMBERSHIP_EVENTS = ["member", "membership", "organization", "repository", "team"] as const;

/**
 * Events that change what the installation covers. Syncing on anything else
 * asks GitHub to confirm what it just told us.
 */
export const INSTALLATION_STATE_EVENTS = ["installation", "installation_repositories"] as const;

export interface WebhookWork {
  readonly provider: "github";
  readonly delivery: string;
  readonly event: string;
  readonly installationId: string | null;
  readonly policyPush: PolicyPush | null;
  readonly appProofTask: AppProofTask | null;
  readonly reconcileProofRepositoryId: string | null;
  /** Whether the consumer should re-read the installation from GitHub. */
  readonly syncInstallation: boolean;
}

export function webhookWork(
  event: string,
  payload: {
    action?: string;
    ref?: string;
    repository?: { id?: number | string; default_branch?: string } | null;
  } & Record<string, unknown>,
  context: { delivery: string; installationId: string | null },
): WebhookWork | null {
  const policyPush = policyPushFromGithubWebhook(event, payload as never);
  const appProofTask = appProofTaskFromWebhook(event, payload as never);
  const reconcileProofRepositoryId =
    event === "push" &&
    payload.repository?.id != null &&
    payload.ref === `refs/heads/${payload.repository.default_branch ?? ""}`
      ? String(payload.repository.id)
      : null;

  const membership = (MEMBERSHIP_EVENTS as readonly string[]).includes(event);
  const installationState = (INSTALLATION_STATE_EVENTS as readonly string[]).includes(event);

  // A pull request rides through unconditionally. It is the event the required
  // check hangs on, its volume is a rounding error next to check_run, and a
  // payload shape that stops short of a proof task at this edge would strand
  // the pull request with no signal anywhere that it happened.
  const pullRequest = event === "pull_request";

  const work =
    policyPush !== null ||
    appProofTask !== null ||
    reconcileProofRepositoryId !== null ||
    pullRequest ||
    membership ||
    installationState;
  if (!work) return null;

  // Every branch that does work needs either the installation or a repository
  // the installation covers, and both are reached through the installation
  // token. A delivery without one cannot be acted on.
  if (context.installationId === null) return null;

  return {
    provider: "github",
    delivery: context.delivery,
    event,
    installationId: context.installationId,
    policyPush,
    appProofTask,
    reconcileProofRepositoryId,
    syncInstallation: membership || installationState,
  };
}
