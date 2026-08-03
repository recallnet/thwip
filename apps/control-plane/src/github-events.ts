/**
 * Which GitHub webhook events the code acts on, and whether the App sends them.
 *
 * The installed App had delivered eighty-two `check_suite` webhooks and nothing
 * else. Not one `pull_request`, `push`, `check_run` or `merge_group`, which
 * means `queueFromPullRequest`, `externalPushFromWebhook`, the policy-push sync
 * and the App-native proof check had never run in this deployment. Everything
 * that worked, worked because the workflows call `/authorize` themselves.
 *
 * The App manifest declared all ten from the start, and that was no help: a
 * manifest describes a fresh registration and says nothing about an App already
 * installed. So the subscription is compared against this list, from the live
 * installation, in the doctor an operator already runs. A test beside this file
 * covers the other half — that this list keeps up with the handlers — because a
 * diagnostic nobody runs and a constant nobody updates fail the same way.
 */
export const HANDLED_WEBHOOK_EVENTS = [
  "check_run",
  "check_suite",
  "member",
  "membership",
  "merge_group",
  "organization",
  "pull_request",
  "push",
  "repository",
  "team",
] as const;

export type HandledWebhookEvent = (typeof HANDLED_WEBHOOK_EVENTS)[number];

// The control plane also mints events for its own queue, which GitHub never
// sends. They are declared in the test beside this file, which is the only
// thing that needs both lists; this one is what the App subscribes to.

/**
 * What a fresh registration asks for. The same list, not a copy of it: the two
 * drifting is what leaves a handler with no delivery behind it.
 */
export const APP_MANIFEST_EVENTS: string[] = [...HANDLED_WEBHOOK_EVENTS];

export interface WebhookEventDrift {
  /** False when GitHub did not say, which is not the same as an empty answer. */
  readonly known: boolean;
  readonly subscribed: string[];
  readonly handled: string[];
  /** Handled here, never delivered. Each one is code that cannot run. */
  readonly deadHandlers: string[];
  /** Delivered, read by nothing. Harmless, but worth naming while looking. */
  readonly unreadSubscriptions: string[];
  readonly healthy: boolean;
}

export function webhookEventDrift(subscribed: readonly string[] | undefined | null): WebhookEventDrift {
  const handled = [...HANDLED_WEBHOOK_EVENTS];
  if (subscribed === undefined || subscribed === null) {
    return {
      known: false,
      subscribed: [],
      handled,
      deadHandlers: handled,
      unreadSubscriptions: [],
      healthy: false,
    };
  }
  const delivered = new Set(subscribed);
  const read = new Set<string>(handled);
  const deadHandlers = handled.filter((event) => !delivered.has(event));
  return {
    known: true,
    subscribed: [...subscribed],
    handled,
    deadHandlers,
    unreadSubscriptions: [...subscribed].filter((event) => !read.has(event)),
    healthy: deadHandlers.length === 0,
  };
}
