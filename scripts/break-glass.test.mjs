import { describe, expect, it } from "vitest";
import {
  GUARDS,
  breakGlassRefusal,
  excuses,
  exceptionStamp,
  parseBreakGlass,
  readException,
} from "./break-glass.mjs";

/**
 * A deploy gate refuses for several different reasons, and until 9 August 2026
 * one environment variable excused all of them at once.
 *
 * `THWIP_DEPLOY_ANYWAY=1` turned off five independent refusals: a checkout
 * behind main, a tree that is not main, a missing schema endpoint, a schema
 * answer that could not be read, and migrations the code needs. Somebody
 * reaching for it to ship an urgent fix from a branch also, silently, shipped
 * against a schema nobody had checked.
 *
 * It left no record either. The queue could not merge its own repair that day,
 * so the repair went out from a branch, and the only trace that production was
 * running unreviewed code was one shell's history.
 */

const REASON = "the queue cannot merge its own repair, so the fix cannot reach main";

describe("declaring a break-glass deploy", () => {
  it("excuses only the guard it names", () => {
    const declared = parseBreakGlass(`unmerged-tree: ${REASON}`);
    expect(excuses(declared, "unmerged-tree")).toBe(true);
    expect(excuses(declared, "pending-migrations")).toBe(false);
  });

  it("excuses several guards when several are named", () => {
    const declared = parseBreakGlass(`unmerged-tree,behind-main: ${REASON}`);
    expect(excuses(declared, "unmerged-tree")).toBe(true);
    expect(excuses(declared, "behind-main")).toBe(true);
  });

  it("excuses nothing when nothing is declared", () => {
    for (const guard of GUARDS) expect(excuses(parseBreakGlass(undefined), guard)).toBe(false);
  });

  /**
   * A guard nobody can name is a guard nobody can turn off by accident, and a
   * typo that silently excused nothing would read as the gate being broken.
   */
  it("refuses a guard it has never heard of", () => {
    expect(parseBreakGlass(`unmerged-treee: ${REASON}`).error).toContain("unmerged-treee");
  });

  it("refuses a declaration with no reason", () => {
    expect(parseBreakGlass("unmerged-tree").error).toContain("reason");
    expect(parseBreakGlass("unmerged-tree: urgent").error).toContain("reason");
  });

  /**
   * The refusal is where somebody learns the mechanism exists, so it carries the
   * line to run rather than the name of a variable to go and look up.
   */
  it("teaches the exact declaration in the refusal", () => {
    const said = breakGlassRefusal("unmerged-tree", "deploy from main so the worker matches what has merged");
    expect(said).toContain("deploy from main");
    expect(said).toContain('THWIP_BREAK_GLASS="unmerged-tree: ');
  });
});

/**
 * What the worker carries afterwards. A break-glass deploy is a claim that
 * production is running something no review passed, and the claim has to outlive
 * the terminal it was made in.
 */
describe("what production says about itself afterwards", () => {
  const stamped = exceptionStamp(parseBreakGlass(`unmerged-tree: ${REASON}`), {
    branch: "home-lane-redesign",
    head: "1bf3ea7",
    at: "2026-08-09T12:57:00.000Z",
  });

  it("carries the reason, the tree and when, not only that something happened", () => {
    const read = readException(stamped);
    expect(read?.reason).toBe(REASON);
    expect(read?.guards).toEqual(["unmerged-tree"]);
    expect(read?.tree).toBe("home-lane-redesign@1bf3ea7");
    expect(read?.at).toBe("2026-08-09T12:57:00.000Z");
  });

  it("stamps nothing on an ordinary deploy", () => {
    expect(exceptionStamp(parseBreakGlass(undefined), { branch: "main", head: "a2a63ab", at: "x" })).toBe("");
    expect(readException("")).toBeNull();
    expect(readException(undefined)).toBeNull();
  });

  /**
   * The stamp is set on every deploy, including ordinary ones, so an ordinary
   * deploy clears it. An exception that could only be cleared by remembering to
   * clear it is an exception that stays until the next incident finds it.
   */
  it("is unreadable rather than trusted when it arrives malformed", () => {
    expect(readException("not a stamp")).toBeNull();
  });
});
