import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS, ENTRY_STATES, TRANSITION_KINDS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import {
  blockedNextAction,
  entryStateText,
  findingTitle,
  healActionLabel,
  healPanelFailure,
  ownerGithubUrl,
  ownerName,
  outcome,
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
