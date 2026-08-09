import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { completedQueueActivationText, SignedOutDashboard } from "./App.js";

/**
 * The frame is the page.
 *
 * Returned on its own, the sign-in card draws as a small box in the top-left
 * corner of an empty page: no header, no width, nothing else on it. That is
 * what someone sees the moment they click through from the homepage, and the
 * loading branch beside it already carries a comment about the same bug being
 * fixed there and nowhere else.
 */
describe("the signed-out dashboard", () => {
  it("keeps the dashboard frame around the sign-in card", () => {
    const html = renderToStaticMarkup(createElement(SignedOutDashboard));

    expect(html).toContain('class="thwip-shell gp-workspace"');
    expect(html).toContain('class="thwip-nav"');
    expect(html).toContain("Sign in with GitHub");
  });
});

describe("completed queue setup copy", () => {
  it("describes ownership and required checks once enforcement is active", () => {
    expect(completedQueueActivationText("enforced")).toBe(
      "It owns normal branch updates and requires the App proof and turn checks.",
    );
  });

  it.each([undefined, "observe", "canary"])("does not claim %s owns branch updates", (activationState) => {
    expect(completedQueueActivationText(activationState)).toBe(
      "It reports what it would do and blocks nothing until you enforce it.",
    );
  });
});
