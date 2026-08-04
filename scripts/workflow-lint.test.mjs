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

describe("workflow lint: scheduled failure reruns", () => {
  const workflow = (trigger, command) => `
name: drain
on:
  ${trigger}
jobs:
  drain:
    runs-on: ubuntu-latest
    steps:
      - run: |
          ${command}
`;

  it("rejects a timer that replays failed workflow records", () => {
    expect(() =>
      validateWorkflow(
        "drain.yml",
        workflow(
          `schedule:\n    - cron: "23,53 * * * *"`,
          `gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/rerun-failed-jobs"`,
        ),
      ),
    ).toThrow(/scheduled workflows must not call rerun-failed-jobs/);
  });

  it("accepts a scheduled queue nudge with no workflow replay", () => {
    expect(() =>
      validateWorkflow(
        "drain.yml",
        workflow(
          `schedule:\n    - cron: "23,53 * * * *"`,
          `curl -X POST "$THWIP_ENDPOINT/v1/queue/$REPO_ID/nudge"`,
        ),
      ),
    ).not.toThrow();
  });

  it("leaves an explicitly requested manual rerun alone", () => {
    expect(() =>
      validateWorkflow(
        "rerun.yml",
        workflow(
          "workflow_dispatch:",
          `gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/rerun-failed-jobs"`,
        ),
      ),
    ).not.toThrow();
  });
});

// A workflow that PATCHes git/refs/heads moves a branch. That is the merge, and a
// merge queue's whole claim is that one pull request at a time drives a branch.
// So the group has to name the branch's queue and nothing narrower. thwip-merge
// keyed its group per pull request, two runs for two pull requests drove one lane
// at once, and pull requests 114, 117 and 119 merged trees no suite had run.
describe("workflow lint: workflows that move a branch ref", () => {
  // The land step PR 123 shipped: a commit composed on the pinned base, then a
  // ref update that does not force.
  const LANDS_ON_THE_PINNED_BASE = `base_pin=$(printf '%s' "$abody" | jq -r '.merge.baseSha // empty')
          tree_pin=$(printf '%s' "$abody" | jq -r '.merge.treeOid // empty')
          parents=$(printf '%s' "$abody" | jq -c '.merge.parentShas // []')
          curl -X POST "https://api.github.com/repos/$GITHUB_REPOSITORY/git/commits" \\
            -d "$(jq -nc --arg tree "$tree_pin" --argjson parents "$parents" '{tree:$tree, parents:$parents}')"
          curl -X PATCH "https://api.github.com/repos/$GITHUB_REPOSITORY/git/refs/heads/main" \\
            -d "$(jq -nc --arg sha "$composed" '{sha:$sha, force:false}')"`;

  const laneWorkflow = (concurrency, land = LANDS_ON_THE_PINNED_BASE) => `
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
          ${land}
`;

  const LANE = `concurrency:
  group: thwip-merge-\${{ github.repository }}
  cancel-in-progress: false`;

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

  // GitHub's merge-pull-request API takes an expected head and no expected base,
  // so it merges onto whatever the branch is at that instant. Pull requests 114,
  // 117, 119 and 121 were each signed against one base and merged onto another,
  // and GitHub called every one of them a success. The only base-binding
  // primitive GitHub has is a ref update without force, so that is what a
  // workflow that merges has to use.
  describe("a merge that binds the base it was verified against", () => {
    const mergeApiWorkflow = `curl -X PUT "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls/$PR/merge" \\
            -d "$(jq -nc --arg sha "$HEAD_SHA" '{sha:$sha, merge_method:"merge"}')"`;

    it("rejects the merge-pull-request API, which has no expected base", () => {
      expect(() => validateWorkflow("lane.yml", laneWorkflow(LANE, mergeApiWorkflow))).toThrow(
        /lane\.yml: merges through the pull-request merge API, which takes an expected head and no expected base/,
      );
    });

    it("rejects a ref update that forces", () => {
      const forced = LANDS_ON_THE_PINNED_BASE.replace("force:false", "force:true");
      expect(() => validateWorkflow("lane.yml", laneWorkflow(LANE, forced))).toThrow(
        /lane\.yml: moves a branch ref with force/,
      );
    });

    it("rejects a ref update that leaves force to the default", () => {
      const silent = LANDS_ON_THE_PINNED_BASE.replace(", force:false", "");
      expect(() => validateWorkflow("lane.yml", laneWorkflow(LANE, silent))).toThrow(
        /lane\.yml: moves a branch ref without saying force:false/,
      );
    });

    it("rejects a ref update to a commit composed from nothing the queue pinned", () => {
      const unpinned = `composed=$(curl -X POST "https://api.github.com/repos/$GITHUB_REPOSITORY/git/commits" \\
            -d '{"tree":"t","parents":["p"]}')
          curl -X PATCH "https://api.github.com/repos/$GITHUB_REPOSITORY/git/refs/heads/main" \\
            -d "$(jq -nc --arg sha "$composed" '{sha:$sha, force:false}')"`;
      expect(() => validateWorkflow("lane.yml", laneWorkflow(LANE, unpinned))).toThrow(
        /lane\.yml: moves a branch ref to a commit it did not compose on the base the queue pinned/,
      );
    });

    it("accepts a commit composed on the pinned base and landed without force", () => {
      expect(() => validateWorkflow("lane.yml", laneWorkflow(LANE))).not.toThrow();
    });
  });
});
