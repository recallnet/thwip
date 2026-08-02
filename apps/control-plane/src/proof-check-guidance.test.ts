import { NEXT_ACTION, nextActionFor, reasonCodes } from "@thwip/vocabulary";
import { describe, expect, it } from "vitest";

import { checkSummary, type AppProofEvaluation } from "./app-proof-verification.js";

/**
 * What the check tells a developer to do about the verdict.
 *
 * Deleting the dead fields from the policy document was right, and it changed
 * the document's digest. Every proof already signed cited the old one, so those
 * pull requests turned red with `POLICY_NOT_ACTIVE` and a summary that named
 * the code and stopped there. Re-running `thwip run` fixes it in seconds, and
 * nothing on the pull request said so.
 *
 * The sentence has existed the whole time, in `@thwip/vocabulary`, written once
 * for all three surfaces. The check simply never read it.
 */

function evaluation(outcome: string): AppProofEvaluation {
  return {
    outcome,
    policyDigest: `sha256:${"a".repeat(64)}`,
    policyVersion: 3,
    configSource: "global",
    targets: [
      { headSha: "b".repeat(40), treeOid: "c".repeat(40), outcome },
    ],
  } as AppProofEvaluation;
}

const detailsUrl = "https://thwip.example/v1/proof-verifications/proof_1";

describe("the check's account of a rejected proof", () => {
  it("tells a developer whose proof cites a superseded policy to sign again", () => {
    const summary = checkSummary(evaluation("POLICY_NOT_ACTIVE"), detailsUrl);

    expect(summary).toContain("POLICY_NOT_ACTIVE");
    expect(summary).toContain(NEXT_ACTION.POLICY_NOT_ACTIVE);
    expect(summary).toMatch(/thwip run/);
  });

  /**
   * Every code, not the handful anyone thought to check. A reason code added to
   * the vocabulary already fails to compile without a sentence; this is what
   * makes the check read it.
   */
  it("carries the next action for every reason code it can conclude", () => {
    for (const code of reasonCodes()) {
      if (code === "PASS") continue;
      expect(checkSummary(evaluation(code), detailsUrl), `${code} arrives with no next action`).toContain(
        nextActionFor(code, "check"),
      );
    }
  });

  it("says nothing extra when the proof passed", () => {
    const summary = checkSummary(evaluation("PASS"), detailsUrl);
    expect(summary).not.toContain(NEXT_ACTION.PASS);
  });

  it("still renders an outcome the vocabulary does not name", () => {
    const summary = checkSummary(evaluation("SOMETHING_NEW"), detailsUrl);
    expect(summary).toContain("SOMETHING_NEW");
  });
});
