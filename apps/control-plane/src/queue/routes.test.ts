import { describe, expect, it } from "vitest";
import { classifyWebhook } from "./routes.js";

/**
 * Route handlers need a Durable Object namespace, so their full behaviour is
 * covered by the staging smoke test rather than here. What is unit-testable is
 * the webhook classification, which decides whether GitHub told us to re-derive
 * readiness or that the branch moved without us.
 */

describe("classifyWebhook", () => {
  it("re-derives readiness for anything that can change eligibility", () => {
    for (const event of [
      "pull_request",
      "pull_request_review",
      "pull_request_review_thread",
      "check_suite",
      "check_run",
      "status",
      "repository_ruleset",
    ]) {
      expect(classifyWebhook(event, {})).toMatchObject({ handled: true, action: "readiness" });
    }
  });

  it("treats a branch push as external movement", () => {
    expect(classifyWebhook("push", { ref: "refs/heads/main" })).toMatchObject({
      handled: true,
      action: "external-transition",
      detail: "refs/heads/main",
    });
  });

  it("ignores a tag push", () => {
    expect(classifyWebhook("push", { ref: "refs/tags/v1" })).toMatchObject({
      handled: false,
      action: "ignored",
    });
  });

  it("ignores a push with no ref", () => {
    expect(classifyWebhook("push", {})).toMatchObject({ handled: false });
  });

  it("ignores events it does not understand rather than guessing", () => {
    for (const event of ["issues", "star", "fork", "deployment", "made_up"]) {
      expect(classifyWebhook(event, {})).toMatchObject({ handled: false, action: "ignored" });
    }
  });
});
