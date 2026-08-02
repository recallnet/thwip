import { describe, expect, it } from "vitest";
import { validateWorkflow } from "./workflow-lint.mjs";

describe("workflow lint", () => {
  it("accepts a valid workflow", () => {
    expect(() =>
      validateWorkflow("valid.yml", `
name: valid
on:
  push:
jobs: {}
`),
    ).not.toThrow();
  });

  it("rejects malformed YAML with the filename", () => {
    expect(() =>
      validateWorkflow("malformed.yml", `
name: malformed
on: [push
`),
    ).toThrow(/malformed\.yml: invalid YAML/);
  });

  it("rejects a workflow without a top-level trigger", () => {
    expect(() =>
      validateWorkflow("missing-trigger.yml", `
name: missing trigger
jobs: {}
`),
    ).toThrow("missing-trigger.yml: no trigger");
  });
});

// A workflow that PATCHes git/refs/heads moves a branch. That is the merge, and a
// merge queue's whole claim is that one pull request at a time drives a branch.
// So the group has to name the branch's queue and nothing narrower. thwip-merge
// keyed its group per pull request, two runs for two pull requests drove one lane
// at once, and pull requests 114, 117 and 119 merged trees no suite had run.
describe("workflow lint: workflows that move a branch ref", () => {
  const laneWorkflow = (concurrency) => `
name: lane
on:
  workflow_run:
    workflows: [thwip]
    types: [completed]
  repository_dispatch:
    types: [thwip-queue-turn]
${concurrency}
jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X PATCH "https://api.github.com/repos/$GITHUB_REPOSITORY/git/refs/heads/main"
`;

  it("accepts a group keyed on the repository alone", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: thwip-merge-\${{ github.repository }}
  cancel-in-progress: false`),
      ),
    ).not.toThrow();
  });

  it("rejects a group keyed per pull request", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: >-
    thwip-merge-\${{ github.event.client_payload.pullRequestNumber || github.event.workflow_run.head_sha }}
  cancel-in-progress: false`),
      ),
    ).toThrow(/lane\.yml: moves a branch ref, so its concurrency group must name the queue/);
  });

  it("names the offending expression so the fix is obvious", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: thwip-merge-\${{ github.event.pull_request.number }}
  cancel-in-progress: false`),
      ),
    ).toThrow(/github\.event\.pull_request\.number/);
  });

  it("rejects a group that varies with the event payload even without a fallback", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: thwip-merge-\${{ github.event.workflow_run.pull_requests[0].base.ref }}
  cancel-in-progress: false`),
      ),
    ).toThrow(/moves a branch ref/);
  });

  it("rejects a workflow that moves a ref with no concurrency at all", () => {
    expect(() => validateWorkflow("lane.yml", laneWorkflow(""))).toThrow(
      /lane\.yml: moves a branch ref and declares no concurrency group/,
    );
  });

  it("rejects an empty group", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: ""
  cancel-in-progress: false`),
      ),
    ).toThrow(/lane\.yml: concurrency group is empty/);
  });

  it("rejects cancel-in-progress on a lane", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: thwip-merge-\${{ github.repository }}
  cancel-in-progress: true`),
      ),
    ).toThrow(/lane\.yml: cancel-in-progress must be false/);
  });

  it("rejects a lane that leaves cancel-in-progress unstated", () => {
    expect(() =>
      validateWorkflow(
        "lane.yml",
        laneWorkflow(`concurrency:
  group: thwip-merge-\${{ github.repository }}`),
      ),
    ).toThrow(/lane\.yml: cancel-in-progress must be false/);
  });

  it("leaves workflows that move no ref alone", () => {
    expect(() =>
      validateWorkflow(
        "verify.yml",
        `
name: verify
on:
  repository_dispatch:
    types: [thwip-queue-verify]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
`,
      ),
    ).not.toThrow();
  });
});
