import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import { nextAction } from "./turn-check.js";
import { nextActionFor } from "../../../../packages/cli/src/queue-exit.js";
import { blockedNextAction, outcome } from "../../web/src/vocabulary.js";

/**
 * The three surfaces, held against each other.
 *
 * A developer whose pull request stops reads a GitHub check, runs the CLI, and
 * opens the dashboard. Each of the three used to carry its own copy of the
 * sentence for a reason code, and the copies were kept in step by hand. They
 * came apart: one event was reported as a changed source in the terminal and as
 * something to fix on the dashboard, and the developer went looking for a bug
 * in code that was fine.
 *
 * Each table stayed drift-proof against its own key set the whole time, which
 * is exactly why nothing caught it. This test reads the three surfaces the way
 * a person meets them, calling what the check publishes, what the CLI prints,
 * and what the dashboard renders, and fails when any two of them disagree.
 *
 * The exceptions are listed below with the argument for each. Adding a fourth
 * means writing that argument down.
 */

const ALLOWED_TO_DIFFER = new Set([
  // The terminal reader is at a prompt, so the CLI names the command to run.
  // Neither of the other two can run it for them.
  "NEEDS_REPAIR",
  // The CLI's checker is this build of thwip and the reader owns it. The other
  // two check with the service, where updating a laptop fixes nothing.
  "PROOF_SCHEMA_UNSUPPORTED",
  // A page reports a verified commit as a state. "Nothing to do" closes a
  // command; it says nothing under a green result.
  "PASS",
]);

describe("one sentence per reason, whichever surface a developer meets first", () => {
  it("agrees on every blocking reason", () => {
    for (const reason of BLOCKING_REASONS) {
      if (ALLOWED_TO_DIFFER.has(reason)) continue;
      expect(blockedNextAction(reason), `${reason} differs on the dashboard`).toBe(nextAction(reason));
      expect(nextActionFor(reason), `${reason} differs in the terminal`).toBe(nextAction(reason));
    }
  });

  it("agrees on every code the proof verifier can return", () => {
    for (const code of REASON_CODES) {
      if (ALLOWED_TO_DIFFER.has(code)) continue;
      expect(outcome(code).detail, `${code} differs on the dashboard`).toBe(nextActionFor(code));
    }
  });

  it("still names a code no surface has a sentence for, rather than inventing one", () => {
    expect(nextAction("SOMETHING_A_NEWER_SERVICE_KNOWS")).toBe("Blocked: SOMETHING_A_NEWER_SERVICE_KNOWS.");
    expect(nextActionFor("SOMETHING_A_NEWER_SERVICE_KNOWS")).toContain("Update thwip");
    expect(blockedNextAction("SOMETHING_A_NEWER_SERVICE_KNOWS")).toContain("Something a newer service knows");
  });

  it("keeps the exceptions honest by holding each to what it says it is", () => {
    // The CLI names a command the other two cannot run.
    expect(nextActionFor("NEEDS_REPAIR")).toContain("thwip ship --wait");
    expect(nextAction("NEEDS_REPAIR")).not.toContain("thwip ship --wait");
    // The dashboard reports a state; the CLI closes a command.
    expect(outcome("PASS").detail).not.toBe(nextActionFor("PASS"));
    expect(nextActionFor("PASS")).toBe("Nothing to do.");
  });
});
