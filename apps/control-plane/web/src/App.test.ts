import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  completedQueueActivationText,
  AddProject,
  DashboardMetrics,
  GitHubSync,
  ORGANIZATION_TABS,
  PROJECT_TABS,
  organizationSection,
  projectPagePanels,
  projectSection,
  SignedOutDashboard,
  RemoveProject,
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

describe("project navigation", () => {
  it("keeps repository setup with the queue job", () => {
    expect(PROJECT_TABS.map(([, label]) => label)).toEqual(["Queue", "Access", "Settings"]);
    expect(projectPagePanels("queue")).toEqual(["setup", "queue"]);
    expect(projectPagePanels("settings")).toEqual(["verification"]);
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

describe("project removal", () => {
  const project = {
    id: "prj_gh_1",
    github_repository_id: "1",
    github_name: "recallnet/playhouse",
    default_branch: "main",
    enabled: 0,
    activation_state: "disabled",
    active_policy_digest: null,
    policy_version: null,
    policy_profile: null,
    config_source: null,
    proof_check_mode: "observe",
    collaborators: 0,
    last_outcome: null,
    last_observed_at: null,
  };
  const me = {
    viewer: { githubUserId: "7", githubOrgRole: "owner", activated: true },
    principal: null,
    organization: {
      id: "org_1",
      github_login: "recallnet",
      plan: "free",
      installation_id: "44",
      better_auth_org_id: null,
    },
    organizations: [],
    appSlug: "thwip",
  };

  it("states the destructive scope, sync behavior, re-add behavior, and separate App access", () => {
    const html = renderToStaticMarkup(createElement(RemoveProject, { project: project as never, me: me as never }));
    expect(html).toContain("policies, proofs, queue, signed chain, access grants, and measured history");
    expect(html).toContain("does not uninstall the GitHub App");
    expect(html).toContain("will not recreate it");
    expect(html).toContain("new, disabled project with no restored history");
    expect(html).toContain("recallnet/playhouse");
    expect(html).toContain("settings/installations/44");
  });

  it("requires an organization owner to explicitly add a fresh project", () => {
    const owner = renderToStaticMarkup(createElement(AddProject, { canAdd: true }));
    const member = renderToStaticMarkup(createElement(AddProject, { canAdd: false }));
    expect(owner).toContain("OWNER/REPOSITORY");
    expect(owner).toContain("fresh, disabled project");
    expect(member).toContain("Only GitHub organization owners can add a project");
    expect(member).not.toContain(">Add project</button>");
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
