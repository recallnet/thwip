import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FAQ_ITEMS } from "@thwip/prompts";
import { completedQueueActivationText, FaqPage } from "./App.js";

describe("completed queue setup copy", () => {
  it("describes ownership and required checks once enforcement is active", () => {
    expect(completedQueueActivationText("enforced")).toBe(
      "It owns normal branch updates and requires the App proof and turn checks.",
    );
  });

  it.each([undefined, "observe", "canary"])("does not claim %s owns branch updates", (activationState) => {
    expect(completedQueueActivationText(activationState)).toBe(
      "It reports what it would do and blocks nothing until you enforce it.",
    );
  });
});

describe("the FAQ page", () => {
  it("renders every question the published markdown has, with an anchor each", () => {
    const html = renderToStaticMarkup(createElement(FaqPage, { me: null }));
    for (const item of FAQ_ITEMS) {
      expect(html, item.q).toContain(`id="${item.id}"`);
      expect(html, item.q).toContain(item.q.replace(/'/g, "&#x27;"));
      // The answer renders as prose (markup is asserted separately below).
      // Compare a prefix that never cuts a tag in half.
      const rendered = item.a
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      let prefix = rendered.slice(0, 24);
      const close = rendered.indexOf(">", 24);
      if (prefix.includes("<") && close !== -1) prefix = rendered.slice(0, close + 1);
      // React escapes these; the comparison must too.
      prefix = prefix.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
      expect(html, item.id).toContain(prefix);
    }
  });

  it("renders inline code and bold from the shared answers", () => {
    const html = renderToStaticMarkup(createElement(FaqPage, { me: null }));
    expect(html).toContain("<code>thwip.yaml</code>");
    expect(html).toContain("<b>fast</b>");
  });
});
