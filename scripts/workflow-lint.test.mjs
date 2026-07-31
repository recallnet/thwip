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
