import { describe, expect, it } from "vitest";
import { summarize } from "./verify-chain.js";

/**
 * What a person sees. A verifier that prints "3 findings" tells them nothing
 * about whether to trust the branch, so the summary leads with the answer and
 * separates history from failure.
 */
describe("the verification summary", () => {
  it("says a clean chain holds", () => {
    expect(summarize(42, [])).toContain("42 links verified");
  });

  it("separates pre-attestation history from real problems", () => {
    const text = summarize(3, [
      { code: "PRE_ATTESTATION", sequence: null, digest: "sha256:a", detail: "written before signed records" },
    ]);
    expect(text).toContain("1 link predates signed records");
    expect(text).not.toMatch(/fail/i);
  });

  it("names a broken link and fails", () => {
    const text = summarize(2, [
      { code: "BROKEN_LINK", sequence: 7, digest: "sha256:b", detail: "names the wrong predecessor" },
    ]);
    expect(text).toMatch(/BROKEN_LINK/);
    expect(text).toMatch(/link 7/);
  });

  it("reports a gap as a merge that landed without a record", () => {
    const text = summarize(2, [
      { code: "SEQUENCE_GAP", sequence: 48, digest: "sha256:c", detail: "a merge landed without a record" },
    ]);
    expect(text).toContain("landed without a record");
  });
});
