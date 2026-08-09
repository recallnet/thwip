import { describe, expect, it } from "vitest";
import { parseThwipYaml } from "@thwip/policy";
import { documentOf, formOf, formRefusal, hasFieldsBeyondTheForm, suiteList } from "./proofDefaults.js";

/**
 * The form that replaced a textarea holding a whole policy document as JSON.
 *
 * Two things have to hold. What the form produces must be a document the control
 * plane accepts, which is checked here against the real parser rather than
 * against a guess at its rules. And the form must not lose the parts of the
 * document it does not show: an owner changing a profile should not silently
 * drop the pipeline their repositories build with.
 */

describe("reading the form out of what is stored", () => {
  it("opens on what the control plane assumes when nothing is stored", () => {
    expect(formOf(null)).toEqual({ profile: "fast", required: "lint, typecheck, test" });
  });

  it("shows what is stored", () => {
    expect(formOf({ version: 1, profile: "audited", required: ["lint", "e2e"] })).toEqual({
      profile: "audited",
      required: "lint, e2e",
    });
  });

  /** A document written by hand can hold anything. The form still has to open. */
  it("falls back rather than showing a profile that is not one", () => {
    expect(formOf({ profile: "paranoid" }).profile).toBe("fast");
  });
});

describe("what the form refuses before sending it", () => {
  it("refuses an empty list, because a proof with nothing required proves nothing", () => {
    expect(formRefusal({ profile: "fast", required: "  " })).toContain("at least one");
  });

  it("names the word that is not a suite id", () => {
    expect(formRefusal({ profile: "fast", required: "lint, Type Check" })).toContain("Type");
  });

  it("catches a suite listed twice", () => {
    expect(formRefusal({ profile: "fast", required: "lint, test, lint" })).toContain("twice");
  });

  it("passes an ordinary list", () => {
    expect(formRefusal({ profile: "fresh", required: "lint, typecheck, test" })).toBeNull();
  });

  it("takes a list separated by spaces as readily as by commas", () => {
    expect(suiteList("lint typecheck  test")).toEqual(["lint", "typecheck", "test"]);
  });
});

describe("the document the form saves", () => {
  /**
   * The rules live in the policy parser, and the server runs the document
   * through it before storing. Asserting against the parser itself is what stops
   * this form drifting from what the control plane will actually take.
   */
  it("produces something the policy parser accepts", () => {
    const doc = documentOf({ profile: "fresh", required: "lint, test" }, null);
    expect(() => parseThwipYaml(JSON.stringify(doc))).not.toThrow();
    expect(parseThwipYaml(JSON.stringify(doc)).profile).toBe("fresh");
  });

  /**
   * The one that matters. `pipeline`, `suites` and `policy` are edited rarely
   * and by people who mean it; a form that replaced the document would drop
   * them the moment somebody changed a profile.
   */
  it("keeps the parts of the document it does not show", () => {
    const existing = {
      version: 1,
      profile: "fast",
      required: ["lint"],
      pipeline: { module: "./ci", daggerVersion: "0.21.8" },
      policy: { minimum_permission: "maintain" },
    };
    const saved = documentOf({ profile: "audited", required: "lint, test" }, existing);
    expect(saved["pipeline"]).toEqual(existing.pipeline);
    expect(saved["policy"]).toEqual(existing.policy);
    expect(saved["profile"]).toBe("audited");
    expect(saved["required"]).toEqual(["lint", "test"]);
  });

  it("keeps a version somebody set rather than resetting it", () => {
    expect(documentOf({ profile: "fast", required: "lint" }, { version: 2 })["version"]).toBe(2);
  });

  it("says when there is more in the document than the form shows", () => {
    expect(hasFieldsBeyondTheForm({ version: 1, profile: "fast", required: ["lint"] })).toBe(false);
    expect(hasFieldsBeyondTheForm({ version: 1, pipeline: { module: "./ci" } })).toBe(true);
    expect(hasFieldsBeyondTheForm(null)).toBe(false);
  });
});
