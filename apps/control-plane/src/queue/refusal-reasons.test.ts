import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isReasonCode, nextActionFor } from "@thwip/vocabulary";

/**
 * Every code the authorization answer puts on the wire, held against the closed
 * union the caller reads it with.
 *
 * `REQUIRED_CHECK_MISSING` shipped in no vocabulary. A caller that read it off
 * the wire got no sentence from `nextActionFor`, no exit class from the CLI, and
 * the dashboard rendered the raw code. The field was typed `string`, so nothing
 * said a word.
 *
 * The type is what stops it now: `TurnAuthorization.reason` is a `ReasonCode`,
 * so a code that is in no list fails the build. This reads the same two files
 * the type covers and asserts the same thing at runtime, because the codes reach
 * that field through `LocalRunRefusal` and `CandidateStateReason` and a cast
 * anywhere along the way would put the compiler back to sleep.
 *
 * It scans rather than listing, so a code added tomorrow is checked without
 * anybody remembering to add it here.
 */

const SOURCES = ["./authorize-turn.ts", "./local-run-gate.ts"];

function codesIn(relative: string): readonly string[] {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const found = source.matchAll(/\b(?:reason|code):\s*"([A-Z][A-Z0-9_]*)"/g);
  return [...new Set([...found].map((match) => match[1] as string))];
}

describe("the reason an authorization refusal names", () => {
  it("is a code some vocabulary declares", () => {
    for (const file of SOURCES) {
      const codes = codesIn(file);
      expect(codes.length, `${file} produced no codes to check`).toBeGreaterThan(0);
      for (const code of codes) {
        expect(isReasonCode(code), `${file} returns ${code}, which is in no vocabulary`).toBe(true);
      }
    }
  });

  it("carries a sentence a caller can act on", () => {
    for (const file of SOURCES) {
      for (const code of codesIn(file)) {
        if (!isReasonCode(code)) continue;
        expect(nextActionFor(code, "check").length, `${code} has no next action`).toBeGreaterThan(0);
      }
    }
  });
});
