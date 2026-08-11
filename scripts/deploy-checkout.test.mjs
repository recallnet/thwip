import { describe, expect, it } from "vitest";

import { deployCheckout } from "./deploy-checkout.mjs";

const SHA = "a".repeat(40);
const facts = (over = {}) => ({
  gitBranch: "HEAD",
  headSha: SHA,
  remoteMainSha: SHA,
  dirty: false,
  ...over,
});
const action = (over = {}) => ({
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "recallnet/thwip",
  GITHUB_REPOSITORY_ID: "1315419165",
  GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: "recallnet/thwip/.github/workflows/deploy-staging.yml@refs/heads/main",
  ...over,
});

describe("the checkout accepted by the deploy gate", () => {
  it("leaves local branch handling unchanged", () => {
    expect(deployCheckout(facts({ gitBranch: "feature" }), {})).toEqual({
      branch: "feature",
      note: null,
      refusal: null,
    });
  });

  it("recognizes the exact detached checkout made by the staging workflow", () => {
    expect(deployCheckout(facts(), action())).toMatchObject({ branch: "main", refusal: null });
  });

  it.each([
    ["a pull request", { GITHUB_EVENT_NAME: "pull_request" }, {}],
    ["another ref", { GITHUB_REF: "refs/heads/topic" }, {}],
    ["another repository", { GITHUB_REPOSITORY: "somebody/thwip" }, {}],
    ["another workflow", { GITHUB_WORKFLOW_REF: "recallnet/thwip/.github/workflows/other.yml@refs/heads/main" }, {}],
    ["a changed checkout", {}, { headSha: "b".repeat(40) }],
    ["main moving after checkout", {}, { remoteMainSha: "b".repeat(40) }],
    ["a dirty checkout", {}, { dirty: true }],
  ])("refuses %s", (_name, envOver, factOver) => {
    expect(deployCheckout(facts(factOver), action(envOver)).refusal).toMatch(/^Refusing/);
  });
});
