import { describe, expect, it } from "vitest";
import { citationsIn, commentsIn } from "./stale-citations.mjs";

/**
 * What counts as a citation, and what is only prose with a slash in it.
 *
 * The whole risk in this check is the second kind. A path check that reports
 * `application/json` or `node:fs` produces a finding a week, every one of them
 * wrong, and a check nobody believes is worse than no check: it is the argument
 * somebody uses for an allowlist.
 */

describe("what is a citation", () => {
  it("takes a path with directories in it", () => {
    expect(citationsIn("see scripts/lint.mjs for the gate")).toContain("scripts/lint.mjs");
  });

  it("takes a bare filename with an extension this repository uses", () => {
    expect(citationsIn("written in plan.md")).toContain("plan.md");
  });

  /**
   * The compiler resolves these before this runs, and more strictly, including
   * the rule that a `.js` specifier names an emitted `.ts` file.
   */
  it("leaves a relative module specifier to the compiler", () => {
    expect(citationsIn("see ./queue-state.js")).toEqual([]);
  });

  it("leaves a path into a build output alone, because a clean tree has none", () => {
    expect(citationsIn("written to dist/main.js")).toEqual([]);
  });

  it("reads a citation followed by a section, and cites the file", () => {
    expect(citationsIn("plan.md §21.2 says so")).toContain("plan.md");
  });

  it("does not take a sentence for a path", () => {
    expect(citationsIn("the specification says so, and the reducer agrees")).toEqual([]);
  });

  it("leaves a URL alone", () => {
    expect(citationsIn("see https://github.com/recallnet/thwip/issues/1")).toEqual([]);
  });

  it("leaves a media type alone", () => {
    expect(citationsIn("answers application/json here")).toEqual([]);
  });

  it("leaves a node builtin alone", () => {
    expect(citationsIn("imported from node:fs")).toEqual([]);
  });

  it("leaves a git ref alone", () => {
    expect(citationsIn("the base is refs/heads/main")).toEqual([]);
  });

  it("leaves a scoped package alone", () => {
    expect(citationsIn("re-exported by @thwip/queue-domain")).toEqual([]);
  });

  it("leaves a glob alone, because a glob names a set rather than a file", () => {
    expect(citationsIn("matches apps/*/src")).toEqual([]);
  });
});

describe("where it looks", () => {
  it("reads a line comment and not the code beside it", () => {
    const found = commentsIn('const p = "src/real.ts"; // see docs/gone.md\n', "a.ts");
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain("docs/gone.md");
    expect(found[0].text).not.toContain("src/real.ts");
  });

  it("reads a block comment across its lines", () => {
    const found = commentsIn("/**\n * see docs/gone.md\n */\nconst x = 1;\n", "a.ts");
    expect(found.map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it("reads a SQL comment", () => {
    expect(commentsIn("-- see migrations/gone.sql\nALTER TABLE t ADD COLUMN c;\n", "m.sql")).toHaveLength(1);
  });

  it("reads a YAML comment", () => {
    expect(commentsIn("# see scripts/gone.mjs\non: push\n", "w.yml")).toHaveLength(1);
  });

  /** A URL in code is not a comment, and `//` in the middle of one is not either. */
  it("does not read a URL as the start of a comment", () => {
    expect(commentsIn('const u = "https://example.com/x";\n', "a.ts")).toHaveLength(0);
  });

  /**
   * A comment opener inside a string is not a comment. Both appear in this
   * repository's own tests, where the naive version read a path out of a quoted
   * example and reported it.
   */
  it("does not read a comment opener inside a string literal", () => {
    expect(commentsIn('const s = "/** not a comment */";\n', "a.ts")).toHaveLength(0);
  });
});
