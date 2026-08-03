import { describe, expect, it } from "vitest";
import { intactLinks, linksWithAGap } from "@thwip/queue-protocol/test/verify-chain-fixtures";
import { checkOwnChain } from "./chain-self-check.js";

describe("checkOwnChain", () => {
  it("reports a chain whose base jumps, because that is a merge nobody recorded", async () => {
    const findings = await checkOwnChain(linksWithAGap(), { epochStartsAt: 1, verifySignature: async () => true });
    expect(findings.map((f) => f.code)).toContain("BASE_DISCONTINUITY");
  });

  it("says nothing about a chain that joins up", async () => {
    const findings = await checkOwnChain(intactLinks(), { epochStartsAt: 1, verifySignature: async () => true });
    expect(findings).toEqual([]);
  });

  /**
   * An empty findings list means nothing when no signature was checked. The
   * verifier returns the count for exactly this reason and a caller that ignores
   * it reports a clean chain having read nothing.
   */
  it("treats a walk that verified no signatures as a finding of its own", async () => {
    const findings = await checkOwnChain(intactLinks(), { epochStartsAt: 9999, verifySignature: async () => true });
    expect(findings.map((f) => f.code)).toContain("NOTHING_CHECKED");
  });
});
