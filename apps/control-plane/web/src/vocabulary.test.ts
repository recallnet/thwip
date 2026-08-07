import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS, ENTRY_STATES, TRANSITION_KINDS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import {
  blockedNextAction,
  blockerFreshness,
  entryStateText,
  findingTitle,
  healActionLabel,
  healPanelFailure,
  ownerGithubUrl,
  ownerName,
  outcome,
  humanise,
  transitionKindText,
} from "./vocabulary.js";

/**
 * One rule, held from several angles: a person never reads a code.
 *
 * Both closed vocabularies grow, and every time one does, something the
 * dashboard prints changes. These tests fail when a code is added without a
 * sentence, which is the only moment anybody is in a position to write one.
 */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*$/;

describe("verification outcomes", () => {
  it("says every reason code the verifier can return in words", () => {
    for (const code of REASON_CODES) {
      const said = outcome(code);
      expect(said.label, code).not.toBe(code);
      expect(said.label, code).not.toMatch(SCREAMING_SNAKE);
      expect(said.label.length, code).toBeGreaterThan(3);
    }
  });

  it("tells the reader what to do, not only what happened", () => {
    for (const code of REASON_CODES) {
      if (code === "PASS") continue;
      expect(outcome(code).detail.length, code).toBeGreaterThan(30);
    }
  });

  it("marks a pass as a pass and a failure as a failure", () => {
    expect(outcome("PASS").tone).toBe("ok");
    expect(outcome("SUBJECT_BASE_MISMATCH").tone).toBe("bad");
  });

  it("says a code it has never seen in words rather than printing it raw", () => {
    const said = outcome("SOMETHING_NEW_ENTIRELY");
    expect(said.label).toBe("Something new entirely");
    expect(said.label).not.toMatch(SCREAMING_SNAKE);
  });

  it("covers the pre-verification state the projection reports", () => {
    expect(outcome("BOOTSTRAP_PENDING").tone).toBe("wait");
  });
});

describe("queue entry states", () => {
  // A few states are already English (`Blocked`, `Merged`). The rule is not
  // that the text differs from the enum, it is that a reader can say it: one
  // leading capital, then words, with no camelCase seam like `ReconnectGrace`.
  it("gives every entry state a reader's name", () => {
    for (const state of ENTRY_STATES) {
      expect(entryStateText(state), state).toMatch(/^[A-Z][a-z]+(?: [a-z]+)*$/);
    }
  });
});

describe("queue guidance", () => {
  it("never shows a bare reason code, known or not", () => {
    for (const reason of [...BLOCKING_REASONS, "SOMETHING_NEW"]) {
      const said = blockedNextAction(reason);
      expect(said, reason).not.toBe(reason);
      expect(said, reason).not.toMatch(SCREAMING_SNAKE);
    }
  });

  it("returns nothing when nothing is blocking", () => {
    expect(blockedNextAction(null)).toBeNull();
  });

  it("says the place is kept wherever that is the reassuring truth", () => {
    for (const reason of ["REVIEW_REQUIRED", "REQUIRED_CHECK_FAILED", "NEEDS_REPAIR"] as const) {
      expect(blockedNextAction(reason), reason).toMatch(/place/);
    }
  });
});

describe("transition kinds", () => {
  it("names every kind the chain can record", () => {
    for (const kind of TRANSITION_KINDS) {
      expect(transitionKindText(kind), kind).not.toBe(kind);
    }
  });

  /**
   * The queue's own transition kinds are PascalCase, and nothing writes a
   * sentence for them, so they fall through to `humanise`. That lowercased the
   * whole word and shipped `Mergerecorded`, `Turnoffered` and `Queuerequested`
   * to the history table on every dashboard.
   *
   * The test above did not catch it: it asserted only that the output differed
   * from the input, and `Mergerecorded` differs from `MergeRecorded`.
   */
  it("splits a name written in capitals into words a reader can say", () => {
    expect(transitionKindText("MergeRecorded")).toBe("Merge recorded");
    expect(transitionKindText("TurnOffered")).toBe("Turn offered");
    expect(transitionKindText("QueueRequested")).toBe("Queue requested");
  });
});

describe("codes nobody has written a sentence for", () => {
  it("reads a screaming code as words", () => {
    expect(humanise("SUBJECT_BASE_MISMATCH")).toBe("Subject base mismatch");
  });

  it("reads a capitalised name as words", () => {
    expect(humanise("MergeGuard")).toBe("Merge guard");
  });

  it("leaves an acronym whole rather than spelling it out letter by letter", () => {
    expect(humanise("CIFailed")).toBe("CI failed");
  });
});

describe("owners", () => {
  const logins = new Map([["370259", "octocat"]]);

  it("resolves a principal id to the person it stands for", () => {
    expect(ownerName("prn_gh_370259", logins)).toBe("octocat");
    expect(ownerGithubUrl("prn_gh_370259", logins)).toBe("https://github.com/octocat");
  });

  it("never shows the database key when the login is not projected yet", () => {
    expect(ownerName("prn_gh_999", logins)).toBe("GitHub user 999");
    expect(ownerGithubUrl("prn_gh_999", logins)).toBeNull();
  });
});

/**
 * A finding on the project page has to say what went wrong and what the button
 * does, and it has to say the second thing differently when there is no button.
 * A page that offers "Record them" for a bad signature is offering a remedy
 * that does not exist, which is worse than saying nothing.
 */
describe("chain findings", () => {
  it("titles a finding without repeating its code at the reader", () => {
    expect(findingTitle("BASE_DISCONTINUITY")).toBe("A merge is missing from this branch's record");
    expect(findingTitle("BAD_SIGNATURE")).not.toContain("BAD_SIGNATURE");
  });

  it("offers a button only where thwip can carry the remedy out", () => {
    expect(healActionLabel({ healable: true, steps: [{ action: "record-merge" }] })).toBe("Record it");
    expect(healActionLabel({ healable: true, steps: [{ action: "record-merge" }, { action: "record-movement" }] })).toBe(
      "Record them",
    );
    expect(healActionLabel({ healable: false, steps: [] })).toBeNull();
  });

  /**
   * The panel used to vanish on any refused read, so a 500 looked exactly like
   * a reader who is not an administrator: a clean page with no findings on it.
   * The one person who could act on a broken check was the one it was hidden
   * from.
   */
  it("hides the panel from a reader it does not belong to and says so when thwip fails", () => {
    expect(healPanelFailure(403)).toBeNull();
    expect(healPanelFailure(500)).toContain("could not check");
    expect(healPanelFailure(undefined)).toContain("could not check");
  });
});

/**
 * A projected blocker is an answer somebody wrote down earlier. The dashboard
 * told a developer to mark pull request 56 ready for review while GitHub had it
 * ready, because the projection had kept `PR_DRAFT` since before the change and
 * the page said it as though it had just looked.
 */
describe("how old a projected blocker is", () => {
  const at = "2026-08-04T12:00:00Z";
  const minutesLater = (minutes: number) => Date.parse(at) + minutes * 60_000;

  it("says nothing about a snapshot read straight from the queue", () => {
    expect(blockerFreshness("queue", null, minutesLater(1))).toBeNull();
  });

  it("dates a fresh projected blocker instead of presenting it as current", () => {
    const said = blockerFreshness("projection", at, minutesLater(3));
    expect(said?.confirmed).toBe(true);
    expect(said?.text).toContain("3m ago");
  });

  it("stops claiming a blocker once nothing has confirmed it for long enough", () => {
    const said = blockerFreshness("projection", at, minutesLater(40));
    expect(said?.confirmed).toBe(false);
    expect(said?.text).toContain("cannot confirm");
  });

  it("treats a projection with no timestamp as unconfirmed rather than as current", () => {
    const said = blockerFreshness("projection", null, minutesLater(1));
    expect(said?.confirmed).toBe(false);
  });
});
