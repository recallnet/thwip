import { describe, expect, it } from "vitest";
import { TRANSITION_KINDS as RECORD_KINDS } from "@thwip/queue-protocol";
import { TRANSITION_KINDS, transitionKindOf } from "./reason-codes.js";

/**
 * One vocabulary for how a transition entered the chain.
 *
 * There were two. The protocol signs seven record kinds; this package listed
 * six of its own, spelled differently, written by hand. Nothing held them
 * against each other, so the control plane carried the translation in three
 * places, each of it the shape `kind === "candidate-verified-merge" || kind ===
 * "verified-merge" ? "verified" : "reused"`. An eighth record kind would have
 * been filed as a reuse by all three, silently, and the chain would have
 * reported a merge as resting on the head's own proof when it did not.
 *
 * The map below is the only translation now, and it is total over the protocol's
 * list, so a record kind added there fails the build until somebody says what it
 * is here.
 */

describe("the kind a transition is recorded under", () => {
  it("has one for every record the protocol can sign", () => {
    for (const record of RECORD_KINDS) {
      expect(TRANSITION_KINDS, `${record} maps to a kind the domain does not list`).toContain(
        transitionKindOf(record),
      );
    }
  });

  it("lists nothing no record maps to", () => {
    const reachable = new Set(RECORD_KINDS.map((record) => transitionKindOf(record)));
    expect([...TRANSITION_KINDS].sort()).toEqual([...reachable].sort());
  });

  it("keeps a verified merge and a reused-proof merge apart", () => {
    expect(transitionKindOf("verified-merge")).toBe("verified");
    expect(transitionKindOf("candidate-verified-merge")).toBe("verified");
    expect(transitionKindOf("reused-proof-merge")).toBe("reused");
  });
});
