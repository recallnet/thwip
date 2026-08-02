import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APP_MANIFEST_EVENTS,
  HANDLED_WEBHOOK_EVENTS,
  INTERNAL_QUEUE_EVENTS,
  webhookEventDrift,
} from "./github-events.js";

/**
 * What the App is subscribed to, against what the code handles.
 *
 * The installed App had never delivered a single `pull_request`, `push`,
 * `check_run` or `merge_group` webhook. Eighty-two `check_suite` deliveries and
 * nothing else. So `queueFromPullRequest`, `externalPushFromWebhook` and the
 * policy-push sync had never once run in this deployment, and everything that
 * did work worked because the workflows call `/authorize` directly.
 *
 * The manifest declares all ten events, but a manifest only describes a fresh
 * registration. Nothing compared it to what the App actually delivers, so a
 * handler can be dead for months without a single failing signal.
 */

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/**
 * Every webhook event the code branches on, read out of the code itself.
 *
 * This is the half a constant cannot keep honest on its own: a handler added
 * for a new event without adding it here would be dead on arrival, exactly as
 * the four above were, and the declaration would still look complete.
 */
function eventsComparedInSource(): Set<string> {
  const files = [
    "index.ts",
    "app-proof-verification.ts",
    "policy-activation.ts",
    "queue/external-push.ts",
  ];
  const found = new Set<string>();
  for (const file of files) {
    for (const match of source(file).matchAll(/event\s*(?:===|!==)\s*"([a-z_]+)"/g)) {
      found.add(match[1]!);
    }
  }
  return found;
}

describe("the events the code handles", () => {
  it("declares every event a handler branches on", () => {
    const declared = new Set<string>([...HANDLED_WEBHOOK_EVENTS, ...INTERNAL_QUEUE_EVENTS]);
    for (const event of eventsComparedInSource()) {
      expect(declared, `${event} is handled in code but not declared, so nothing asks GitHub to send it`).toContain(
        event,
      );
    }
  });

  /**
   * An internal event listed as a webhook event would report as delivered by an
   * App that never sends it, which would make the diagnostic lie in the
   * reassuring direction.
   */
  it("keeps the events it mints for itself out of the subscription", () => {
    const handled = new Set<string>(HANDLED_WEBHOOK_EVENTS);
    for (const event of INTERNAL_QUEUE_EVENTS) expect(handled).not.toContain(event);
  });

  it("names the ten the router acts on", () => {
    expect([...HANDLED_WEBHOOK_EVENTS]).toEqual([
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
    ]);
  });

  /**
   * The manifest is the one place a fresh registration gets its subscription
   * from, so it must be the same list rather than a copy of it. A literal array
   * there is how the two drift.
   */
  it("registers a new App for exactly what the code handles", () => {
    expect(APP_MANIFEST_EVENTS).toEqual([...HANDLED_WEBHOOK_EVENTS]);
    expect(source("index.ts")).toContain("default_events: APP_MANIFEST_EVENTS");
    expect(source("index.ts")).not.toMatch(/default_events:\s*\[/);
  });
});

describe("comparing an installation against the code", () => {
  it("names a handler nothing will ever deliver to", () => {
    const drift = webhookEventDrift(["check_suite"]);
    expect(drift.deadHandlers).toContain("pull_request");
    expect(drift.deadHandlers).toContain("push");
    expect(drift.deadHandlers).toContain("check_run");
    expect(drift.deadHandlers).toContain("merge_group");
    expect(drift.healthy).toBe(false);
  });

  it("reports healthy when the App delivers everything the code handles", () => {
    const drift = webhookEventDrift([...HANDLED_WEBHOOK_EVENTS]);
    expect(drift.deadHandlers).toEqual([]);
    expect(drift.healthy).toBe(true);
  });

  it("names a subscription nothing reads, without calling it unhealthy", () => {
    const drift = webhookEventDrift([...HANDLED_WEBHOOK_EVENTS, "star"]);
    expect(drift.unreadSubscriptions).toEqual(["star"]);
    expect(drift.healthy).toBe(true);
  });

  /**
   * GitHub omitting the field is not the same as an App subscribed to nothing,
   * and answering "healthy" to an unknown is how this went unseen for months.
   */
  it("refuses to call an unknown subscription healthy", () => {
    const drift = webhookEventDrift(undefined);
    expect(drift.known).toBe(false);
    expect(drift.healthy).toBe(false);
  });
});
