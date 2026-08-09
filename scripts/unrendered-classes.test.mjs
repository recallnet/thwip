import { describe as renderFindings, unrenderedClasses } from "./unrendered-classes.mjs";
import { describe, expect, it } from "vitest";

function css(text) {
  return [{ path: "app.css", text }];
}
function markup(text) {
  return [{ path: "App.tsx", text }];
}

describe("classes this repository styles and never renders", () => {
  it("says nothing about a class the markup uses", () => {
    const found = unrenderedClasses({
      styles: css(".thwip-nav { padding: 0; }"),
      sources: markup('<nav className="thwip-nav" />'),
    });
    expect(found).toEqual([]);
  });

  it("finds a class no markup mentions", () => {
    const found = unrenderedClasses({
      styles: css(".thwip-hero { padding: 0; }"),
      sources: markup('<div className="thwip-nav" />'),
    });
    expect(found).toEqual([{ className: "thwip-hero", path: "app.css", line: 1 }]);
  });

  /**
   * A rule is reached through the class it hangs off. Reading `:hover` or
   * `__title` as separate names would report every state of a class that is
   * rendered perfectly well.
   */
  it("resolves states, elements and descendants to the class that carries them", () => {
    const found = unrenderedClasses({
      styles: css(`
        .thwip-nav:hover { color: red; }
        .thwip-nav .links a { color: red; }
        .thwip-nav::before { content: ""; }
        .thwip-panel__title { color: red; }
      `),
      sources: markup('<nav className="thwip-nav"><span className="links" /></nav>'),
    });
    expect(found.map((f) => f.className)).toEqual(["thwip-panel__title"]);
  });

  /**
   * A name finished by an interpolation is a use of everything that can start
   * that way. `eb-callout--${type}` is how the blog draws its callouts, and
   * reading it as the literal `eb-callout--` reported both real variants.
   */
  it("counts every class an interpolated name could produce", () => {
    const found = unrenderedClasses({
      styles: css(".eb-callout--tip { color: red; }\n.eb-callout--warning { color: red; }"),
      sources: markup("class={`eb-callout eb-callout--${type}`}"),
    });
    expect(found).toEqual([]);
  });

  /** A name built at runtime is still a use. */
  it("counts a class named inside a template or a conditional", () => {
    const found = unrenderedClasses({
      styles: css(".mq-strength__on { color: red; }\n.mq-row--open { color: red; }"),
      sources: markup("className={`mq-row ${open ? 'mq-row--open' : ''}`}\nx = 'mq-strength__on'"),
    });
    expect(found).toEqual([]);
  });

  /** Element and attribute selectors carry no class and are not this check's business. */
  it("ignores rules that hang off no class at all", () => {
    const found = unrenderedClasses({
      styles: css("h1, h2 { margin: 0; }\ninput:focus-visible { outline: 0; }\n:root { --ink: #111; }"),
      sources: markup("<h1 />"),
    });
    expect(found).toEqual([]);
  });

  it("names the file and line so the rule can be found and deleted", () => {
    const lines = renderFindings([{ className: "thwip-hero", path: "skin.css", line: 12 }]);
    expect(lines).toEqual(["skin.css:12 .thwip-hero"]);
  });
});
