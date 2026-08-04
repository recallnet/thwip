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
name: recovery
on:
  ${trigger}
jobs:
  recover:
    runs-on: ubuntu-latest
    steps:
      - run: |
          ${command}
`;

  it("rejects a timer that replays failed workflow records", () => {
    expect(() =>
      validateWorkflow(
        "recovery.yml",
        workflow(
          `schedule:\n    - cron: "23,53 * * * *"`,
          `gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/rerun-failed-jobs"`,
        ),
      ),
    ).toThrow(/scheduled workflows must not call rerun-failed-jobs/);
  });

  it("accepts a timer that reconciles current state", () => {
    expect(() =>
      validateWorkflow(
        "recovery.yml",
        workflow(`schedule:\n    - cron: "23,53 * * * *"`, `curl "$CONTROL_PLANE/reconcile"`),
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
