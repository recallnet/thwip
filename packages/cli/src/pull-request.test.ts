import { describe, expect, it } from "vitest";
import { openPullRequestNumber } from "./pull-request.js";

describe("openPullRequestNumber", () => {
  it("reads the number of an open pull request", () => {
    expect(openPullRequestNumber('{"number":42,"state":"OPEN"}')).toBe(42);
  });

  it("refuses a merged pull request on the same branch name", () => {
    // What this exists for: branch names get reused, and `gh pr view` answers
    // with the most recent pull request for the branch whatever state it is in.
    // A reused branch made ship read a merged pull request as the one it had
    // just pushed, so it skipped opening one and queued a number that named
    // somebody else's merged work.
    expect(openPullRequestNumber('{"number":167,"state":"MERGED"}')).toBeNull();
  });

  it("refuses a closed pull request", () => {
    expect(openPullRequestNumber('{"number":9,"state":"CLOSED"}')).toBeNull();
  });

  it("refuses output it cannot read rather than guessing a number", () => {
    expect(openPullRequestNumber("")).toBeNull();
    expect(openPullRequestNumber("no pull requests found for branch")).toBeNull();
    expect(openPullRequestNumber('{"number":0,"state":"OPEN"}')).toBeNull();
    expect(openPullRequestNumber('{"state":"OPEN"}')).toBeNull();
  });

  it("refuses a number without a state, because state is what it is checking", () => {
    // An older gh, or a call that forgot to ask for the state, must not read as
    // an open pull request. Absence of the field is not a pass.
    expect(openPullRequestNumber('{"number":42}')).toBeNull();
  });
});
