import { describe, expect, it } from "vitest";
import { summarize, verifyPublishedChain, type ChainResponse } from "./verify-chain.js";

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

/**
 * The wire link carries `sequence`, and it is what distinguishes a record that
 * has gone missing from history predating signed records. Dropping it on the
 * way into `verifyChain` would silently turn every gap into harmless history.
 */
describe("verifyPublishedChain", () => {
  it("reports an empty link within the attested range as a missing record", async () => {
    const chain: ChainResponse = {
      epochStartsAt: 42,
      links: [{ digest: "sha256:a", sequence: 47, record: "", jws: "" }],
    };
    const { findings } = await verifyPublishedChain(chain, { keys: [] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("MISSING_RECORD");
    expect(codes).not.toContain("PRE_ATTESTATION");
  });

  it("reports an empty link before the epoch as pre-attestation history", async () => {
    const chain: ChainResponse = {
      epochStartsAt: 42,
      links: [{ digest: "sha256:a", sequence: 3, record: "", jws: "" }],
    };
    const { findings } = await verifyPublishedChain(chain, { keys: [] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("PRE_ATTESTATION");
    expect(codes).not.toContain("MISSING_RECORD");
  });
});
