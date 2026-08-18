import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENDPOINT, readActionContext, readActionInputs } from "./context.js";

function eventFile(event: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "thwip-action-event-")), "event.json");
  writeFileSync(path, JSON.stringify(event));
  return path;
}

describe("Action inputs", () => {
  it("uses the hosted endpoint and declared token input", () => {
    expect(readActionInputs({ "INPUT_GITHUB-TOKEN": "token" })).toEqual({
      endpoint: DEFAULT_ENDPOINT,
      githubToken: "token",
      githubApiUrl: "https://api.github.com",
    });
  });

  it("accepts only an HTTPS origin as the endpoint", () => {
    expect(readActionInputs({ INPUT_ENDPOINT: "https://self-hosted.example/" }).endpoint).toBe(
      "https://self-hosted.example",
    );
    expect(() => readActionInputs({ INPUT_ENDPOINT: "https://user@example.test/path?secret=yes" })).toThrow(
      "endpoint must be an HTTPS origin",
    );
    expect(() => readActionInputs({ INPUT_ENDPOINT: "http://self-hosted.example" })).toThrow(
      "endpoint must be an HTTPS origin",
    );
  });
});

describe("Action event context", () => {
  it("reads the pull-request facts without workflow environment plumbing", () => {
    const path = eventFile({
      repository: { id: 12, full_name: "example/project", owner: { id: 34 } },
      pull_request: {
        number: 56,
        draft: true,
        base: { ref: "main" },
        head: { sha: "abc" },
        user: { id: 78 },
      },
    });
    expect(
      readActionContext({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: "90" }),
    ).toEqual({
      kind: "pull_request",
      repositoryId: "12",
      repositoryOwnerId: "34",
      repository: "example/project",
      pullRequestNumber: 56,
      baseRefName: "main",
      headSha: "abc",
      authorGithubUserId: "78",
      draft: true,
      runId: "90",
    });
  });

  it("reads only the trusted callback fields the reporter needs", () => {
    const path = eventFile({
      action: "thwip-queue-verify",
      repository: { id: 12 },
      client_payload: {
        dispatchNonce: "nonce",
        workflowCommitSha: "expected",
        candidateSha: "untrusted-and-unused",
      },
    });
    expect(
      readActionContext({
        GITHUB_EVENT_NAME: "repository_dispatch",
        GITHUB_EVENT_PATH: path,
        GITHUB_WORKFLOW_SHA: "actual",
      }),
    ).toEqual({
      kind: "candidate_report",
      repositoryId: "12",
      dispatchNonce: "nonce",
      expectedWorkflowSha: "expected",
      actualWorkflowSha: "actual",
    });
  });

  it("rejects other events and dispatch actions", () => {
    const dispatch = eventFile({ action: "other", repository: { id: 12 }, client_payload: {} });
    expect(() =>
      readActionContext({ GITHUB_EVENT_NAME: "repository_dispatch", GITHUB_EVENT_PATH: dispatch }),
    ).toThrow("unsupported repository_dispatch action");
    expect(() => readActionContext({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile({}) })).toThrow(
      "unsupported event push",
    );
  });
});
