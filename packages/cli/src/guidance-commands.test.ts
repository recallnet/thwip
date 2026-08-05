import { describe, expect, it } from "vitest";
import { NEXT_ACTION, SURFACES, SURFACE_NEXT_ACTION } from "@thwip/vocabulary";
import { parseCliArgs } from "./cli-args.js";

/**
 * Every command a refusal tells somebody to run has to be a command that runs.
 *
 * `AGENT_OFFLINE` said "Start thwip ship". Plain `thwip ship` queues the branch
 * and exits, so the machine it names goes away again immediately and the entry
 * goes straight back to offline. Under `fresh` that is the whole profile:
 * nothing merges until a machine stays connected, and the sentence sent people
 * to a command that leaves.
 *
 * A sentence naming a command nobody can run is the same failure as a check
 * that passes because its input was never populated. This reads the commands
 * back out of the guidance and puts them through the real parser.
 */

/**
 * Every `thwip …` invocation any guidance sentence tells somebody to run.
 *
 * Only where the sentence is telling them to run it. The word also appears as
 * an ordinary noun ("the assignment thwip handed this machine"), and reading
 * those as commands makes the check fail on prose rather than on defects.
 */
function commandsNamedIn(sentence: string): string[] {
  const invocation = /(?:\brun |, or )thwip ((?:[a-z][\w-]*|--[\w-]+)(?: (?:[a-z][\w-]*|--[\w-]+))*)/gi;
  return [...sentence.matchAll(invocation)].map((m) => m[1]);
}

function everySentence(): Array<{ where: string; said: string }> {
  const all = Object.entries(NEXT_ACTION).map(([code, said]) => ({ where: code, said }));
  for (const surface of SURFACES) {
    for (const [code, said] of Object.entries(SURFACE_NEXT_ACTION[surface])) {
      all.push({ where: `${surface}:${code}`, said });
    }
  }
  return all;
}

/**
 * Whether any prefix of the words after `thwip` is a command.
 *
 * Guidance is prose, so the words after a command run on into the sentence and
 * there is no reliable place to stop. Asking whether some prefix parses catches
 * the thing worth catching, which is a first word that is not a command at all.
 * It does not check the arguments, and the second test below covers the one
 * case where the arguments are the point.
 */
function someCommandPrefixParses(named: string): boolean {
  const words = named.split(" ").map((word) => (word === "OWNER/NAME" ? "owner/name" : word));
  return words.some((_, i) => parseCliArgs(words.slice(0, i + 1)).kind !== "error");
}

describe("commands named in guidance", () => {
  it("names only commands the CLI accepts", () => {
    let checked = 0;
    for (const { where, said } of everySentence()) {
      for (const named of commandsNamedIn(said)) {
        checked += 1;
        expect(someCommandPrefixParses(named), `${where} names \`thwip ${named}\`, and no command starts it`).toBe(
          true,
        );
      }
    }
    // Otherwise a regex that stopped matching would report every sentence clean.
    expect(checked).toBeGreaterThan(5);
  });

  it("sends an offline machine to a command that stays connected", () => {
    // Both forms heartbeat for as long as they run. Anything else names a
    // process that exits, which is what put the entry offline to begin with.
    expect(NEXT_ACTION.AGENT_OFFLINE).toMatch(/thwip (ship --wait|queue work)/);
  });
});
