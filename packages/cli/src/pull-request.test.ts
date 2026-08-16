import { describe, expect, it } from "vitest";
import { openPullRequest, pullRequestCommand } from "./pull-request.js";

describe("openPullRequest", () => {
  it("reads the number of an open pull request", () => {
    expect(openPullRequest('{"number":42,"state":"OPEN","isDraft":false}')).toEqual({
      number: 42,
      isDraft: false,
    });
  });

  it("refuses a merged pull request on the same branch name", () => {
    // What this exists for: branch names get reused, and `gh pr view` answers
    // with the most recent pull request for the branch whatever state it is in.
    // A reused branch made ship read a merged pull request as the one it had
    // just pushed, so it skipped opening one and queued a number that named
    // somebody else's merged work.
    expect(openPullRequest('{"number":167,"state":"MERGED","isDraft":false}')).toBeNull();
  });

  it("refuses a closed pull request", () => {
    expect(openPullRequest('{"number":9,"state":"CLOSED","isDraft":false}')).toBeNull();
  });

  it("refuses output it cannot read rather than guessing a number", () => {
    expect(openPullRequest("")).toBeNull();
    expect(openPullRequest("no pull requests found for branch")).toBeNull();
    expect(openPullRequest('{"number":0,"state":"OPEN","isDraft":false}')).toBeNull();
    expect(openPullRequest('{"state":"OPEN","isDraft":false}')).toBeNull();
  });

  it("refuses a number without a state, because state is what it is checking", () => {
    // An older gh, or a call that forgot to ask for the state, must not read as
    // an open pull request. Absence of the field is not a pass.
    expect(openPullRequest('{"number":42,"isDraft":false}')).toBeNull();
  });

  it("reads the draft state from GitHub rather than guessing it", () => {
    expect(openPullRequest('{"number":42,"state":"OPEN","isDraft":true}')).toEqual({
      number: 42,
      isDraft: true,
    });
    expect(openPullRequest('{"number":42,"state":"OPEN","isDraft":false}')).toEqual({
      number: 42,
      isDraft: false,
    });
  });

  it("refuses an answer without an exact draft state", () => {
    expect(openPullRequest('{"number":42,"state":"OPEN"}')).toBeNull();
    expect(openPullRequest('{"number":42,"state":"OPEN","isDraft":"true"}')).toBeNull();
  });
});

describe("pullRequestCommand", () => {
  it("creates a draft when draft shipping starts without a pull request", () => {
    expect(pullRequestCommand(null, true)).toEqual(["pr", "create", "--fill", "--draft"]);
  });

  it("keeps an existing draft as a draft", () => {
    expect(pullRequestCommand({ number: 42, isDraft: true }, true)).toBeNull();
  });

  it("converts an existing ready pull request when draft mode was explicit", () => {
    expect(pullRequestCommand({ number: 42, isDraft: false }, true)).toEqual([
      "pr",
      "ready",
      "42",
      "--undo",
    ]);
  });

  it("does not redefine the general no-queue path as draft creation", () => {
    expect(pullRequestCommand(null, false)).toEqual(["pr", "create", "--fill"]);
    expect(pullRequestCommand({ number: 42, isDraft: false }, false)).toBeNull();
  });
});
