import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  completedQueueActivationText,
  DashboardMetrics,
  GitHubSync,
  ORGANIZATION_TABS,
  organizationSection,
  SignedOutDashboard,
} from "./App.js";

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

describe("organization navigation", () => {
  it("shows only pages with an ordinary dashboard job", () => {
    expect(ORGANIZATION_TABS.map(([, label]) => label)).toEqual(["Projects", "People & teams", "Settings"]);
  });

  it("sends old policy history links to Projects", () => {
    expect(organizationSection("policies")).toBe("");
  });

  it("sends old operations links to the recovery control in Settings", () => {
    expect(organizationSection("operations")).toBe("settings");
  });
});

describe("the full sync recovery control", () => {
  it("is available to a GitHub organization owner", () => {
    const html = renderToStaticMarkup(createElement(GitHubSync, { canSync: true }));

    expect(html).toContain("Run full sync");
    expect(html).not.toContain("Only GitHub organization owners");
  });

  it("does not offer the action to an ordinary member", () => {
    const html = renderToStaticMarkup(createElement(GitHubSync, { canSync: false }));

    expect(html).not.toContain("Run full sync");
    expect(html).toContain("Only GitHub organization owners can run a full sync.");
  });
});

describe("the organization's reused-CI measurements", () => {
  it("distinguishes loading, empty and partial history", () => {
    const loading = renderToStaticMarkup(createElement(DashboardMetrics, { metrics: null, error: null }));
    const empty = renderToStaticMarkup(
      createElement(DashboardMetrics, {
        metrics: {
          status: "empty",
          signedSuiteDurationMs: 0,
          signedWallClockDurationMs: 0,
          verificationOverheadMs: 0,
          mergedProofs: 0,
          knownReusedMerges: 0,
          unmeasuredMergedProofs: 0,
        },
        error: null,
      }),
    );
    const partial = renderToStaticMarkup(
      createElement(DashboardMetrics, {
        metrics: {
          status: "partial",
          signedSuiteDurationMs: 5_000,
          signedWallClockDurationMs: 6_000,
          verificationOverheadMs: 30,
          mergedProofs: 2,
          knownReusedMerges: 3,
          unmeasuredMergedProofs: 1,
        },
        error: null,
      }),
    );

    expect(loading).toContain("Loading measured results");
    expect(empty).toContain("No merge has reused a measured proof yet");
    expect(partial).toContain("Verified local CI reused");
    expect(partial).toContain("6s");
    expect(partial).toContain("2 measured · 1 older merge has no timing");
    expect(partial).toContain("not developer waiting time or money saved");
  });
});
