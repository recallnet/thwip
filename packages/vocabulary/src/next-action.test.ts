import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import { NEXT_ACTION, SURFACES, SURFACE_NEXT_ACTION, nextActionFor } from "./next-action.js";
import { isReasonCode, reasonCodes } from "./reason-codes.js";

/**
 * The table is a `Record` over a closed union, so a code without a sentence
 * never compiles. What a compiler cannot hold is the house style, and it cannot
 * hold the count of surfaces that were allowed to say something different.
 */

describe("the shared table", () => {
  it("has a sentence for every code any surface can be handed", () => {
    for (const code of reasonCodes()) {
      expect(nextActionFor(code, "check").length, code).toBeGreaterThan(0);
    }
  });

  it("covers both closed vocabularies it is assembled from", () => {
    for (const reason of BLOCKING_REASONS) expect(isReasonCode(reason), reason).toBe(true);
    for (const code of REASON_CODES) expect(isReasonCode(code), code).toBe(true);
  });

  it("writes every sentence the way the house writes prose", () => {
    for (const surface of SURFACES) {
      for (const code of reasonCodes()) {
        const said = nextActionFor(code, surface);
        expect(said, `${code} on ${surface} ends without a full stop`).toMatch(/[.]$/);
        expect(said, `${code} on ${surface} was written with an em dash`).not.toContain("—");
        expect(said, `${code} on ${surface} shouts its own code`).not.toContain(code);
        expect(said.charAt(0), `${code} on ${surface} does not start with a capital`).toMatch(/[A-Z]/);
      }
    }
  });
});

describe("the sentences that are not shared", () => {
  /**
   * Every departure, named. Adding one means editing this list, which is the
   * moment somebody has to say why a developer should read two things.
   */
  const DECLARED: ReadonlyArray<readonly [string, string]> = [
    ["terminal", "NEEDS_REPAIR"],
    ["terminal", "PROOF_SCHEMA_UNSUPPORTED"],
    ["dashboard", "PASS"],
  ];

  it("has exactly the departures that were argued for", () => {
    const found = SURFACES.flatMap((surface) =>
      Object.keys(SURFACE_NEXT_ACTION[surface]).map((code) => `${surface}:${code}`),
    ).sort();
    expect(found).toEqual(DECLARED.map(([surface, code]) => `${surface}:${code}`).sort());
  });

  it("keeps no override that has drifted back into agreement", () => {
    for (const surface of SURFACES) {
      for (const [code, said] of Object.entries(SURFACE_NEXT_ACTION[surface])) {
        expect(said, `${surface}:${code} says what the shared table already says`).not.toBe(
          NEXT_ACTION[code as keyof typeof NEXT_ACTION],
        );
      }
    }
  });

  it("says the same thing everywhere else", () => {
    const declared = new Set(DECLARED.map(([surface, code]) => `${surface}:${code}`));
    for (const code of reasonCodes()) {
      for (const surface of SURFACES) {
        if (declared.has(`${surface}:${code}`)) continue;
        expect(nextActionFor(code, surface), `${code} differs on ${surface}`).toBe(
          nextActionFor(code, "check"),
        );
      }
    }
  });
});
