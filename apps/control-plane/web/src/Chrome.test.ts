import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFoot } from "./Chrome.js";

describe("site footer", () => {
  it("carries the fast-shipping promise", () => {
    expect(renderToStaticMarkup(createElement(SiteFoot))).toContain(
      "thwip · merge fast. ship more. · recall.net",
    );
  });
});
