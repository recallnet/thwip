import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AddRepositoriesButton,
  completedQueueActivationText,
  DashboardMetrics,
  GitHubSync,
  ManageRepositories,
  ORGANIZATION_TABS,
  PROJECT_TABS,
  organizationSection,
  projectPagePanels,
  projectSection,
  ProjectQueueHead,
  ProjectInitPanel,
  QUEUE_SETUP_COMMAND,
  ProjectSetupDisclosure,
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
  it("uses a queue setup command that works without a global install", () => {
    expect(QUEUE_SETUP_COMMAND).toBe("npx @recallnet/thwip@latest queue setup");
  });
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

describe("the organization project table", () => {
  it("links a blocked head directly to its pull request", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectQueueHead, {
        projectName: "recallnet/thwip",
        enabled: true,
        head: { pullRequestNumber: 42, state: "Blocked", primaryReason: "CODEOWNER_REVIEW_REQUIRED" },
      }),
    );

    expect(html).toContain('href="https://github.com/recallnet/thwip/pull/42"');
    expect(html).toContain("#42");
    expect(html).toContain("blocked");
  });

  it("shows the GitHub repository action as a button without explanatory copy", () => {
    const html = renderToStaticMarkup(
      createElement(AddRepositoriesButton, {
        installUrl: "https://github.com/organizations/recallnet/settings/installations/44",
      }),
    );

    expect(html).toContain('class="gp-btn gp-btn--sm"');
    expect(html).toContain("Add repositories on GitHub");
    expect(html).not.toContain("Grant the thwip App");
    expect(html).not.toContain("New repositories import disabled");
  });
});

describe("project navigation", () => {
  it("puts the live queue before repository setup", () => {
    expect(PROJECT_TABS.map(([, label]) => label)).toEqual(["Queue", "Access", "Settings"]);
    expect(projectPagePanels("queue", true)).toEqual(["init", "queue", "setup"]);
    expect(projectPagePanels("queue", false)).toEqual(["init", "setup", "queue"]);
    expect(projectPagePanels("access")).toEqual(["init", "access"]);
    expect(projectPagePanels("settings")).toEqual(["init", "verification"]);
  });

  it("keeps the init action visible for a completed project without guessing laptop state", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectInitPanel, {
        project: {
          id: "p1",
          github_repository_id: "1",
          github_name: "example/project",
          default_branch: "release",
          enabled: 1,
          activation_state: "active",
          active_policy_digest: "digest",
          policy_version: 1,
          policy_profile: "fast",
          config_source: "global",
          proof_check_mode: "enforced",
          collaborators: 1,
          last_outcome: null,
          last_observed_at: null,
          queue_setup_complete: true,
        },
      }),
    );
    expect(html).toContain("Use Thwip in example/project");
    expect(html).toContain("npx @recallnet/thwip@latest init");
    expect(html).toContain("Inspect the live project state");
    expect(html).not.toContain("example/project is already enrolled");
    expect(html).not.toContain("signing key on this machine is registered");
  });

  it("collapses completed setup and leaves incomplete setup open", () => {
    const complete = renderToStaticMarkup(
      createElement(ProjectSetupDisclosure, {
        complete: true,
        children: createElement("p", null, "controls"),
      }),
    );
    const incomplete = renderToStaticMarkup(
      createElement(ProjectSetupDisclosure, {
        complete: false,
        children: createElement("p", null, "controls"),
      }),
    );

    expect(complete).toContain("Setup");
    expect(complete).toContain("Repository setup and queue controls.");
    expect(complete).toContain('class="thwip-setup-disclosure__title"');
    expect(complete).toContain("Complete");
    expect(complete).not.toContain('open=""');
    expect(incomplete).toContain("Required");
    expect(incomplete).toContain('open=""');
  });

  it("sends old setup links to Queue without changing old overview links", () => {
    expect(projectSection("setup")).toBe("queue");
    expect(projectSection("overview")).toBe("settings");
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

describe("GitHub-owned project lifecycle", () => {
  const me = {
    viewer: { githubUserId: "7", githubOrgRole: "owner", activated: true },
    principal: null,
    organization: {
      id: "org_1",
      github_login: "recallnet",
      plan: "free",
      installation_id: "44",
      repository_selection: "selected",
      better_auth_org_id: null,
    },
    organizations: [],
    appSlug: "thwip",
  };

  it("links to GitHub without repeating repository lifecycle details", () => {
    const html = renderToStaticMarkup(createElement(ManageRepositories, { me: me as never }));
    expect(html).toContain("Manage repositories on GitHub");
    expect(html).toContain("settings/installations/44");
    expect(html).not.toContain("policies, proofs, queue, signed chain, access grants, and measured history");
    expect(html).not.toContain("disable its two Thwip rulesets");
    expect(html).not.toContain("Newly selected repositories arrive disabled");
    expect(html).not.toContain("one-hour safety period");
    expect(html).not.toContain("Add project");
    expect(html).not.toContain("Restore");
  });

  it("shows the clean-import deadline reported for the selected organization", () => {
    const readyAt = "2030-01-01T01:00:00.000Z";
    const html = renderToStaticMarkup(createElement(ManageRepositories, {
      me: {
        ...me,
        organization: {
          ...me.organization,
          pending_reimports: { count: 1, ready_at: readyAt },
        },
      } as never,
    }));

    expect(html).toContain("1 repository is pending a clean import");
    expect(html).toContain(new Date(readyAt).toLocaleString());
  });
});

describe("the organization's reused-CI measurements", () => {
  it("distinguishes loading and empty states from aggregate totals", () => {
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
    expect(partial).toContain("CI that ran on dev machines, not hosted runners");
    expect(partial).toContain("6s");
    expect(partial).toContain("What verifying them cost");
    expect(partial).toContain("2 measured runs, total signed runtime and verification time");
    expect(partial).toContain("3 signed merge records, total count");
    expect(partial).not.toMatch(/older merge|partial history/i);
    expect(partial).toContain("not developer waiting time or money saved");
  });
});
