import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { parseFaq, renderBlocks } from "./faq.js";

/**
 * What the page actually puts on screen.
 *
 * The first version of this rendered each whole answer through the inline
 * renderer, so every block boundary collapsed and the four security profiles
 * came out as one run-on line with the bullets gone. Parsing into blocks is
 * only half the fix; this reads the markup that reaches the reader.
 */
describe("the markup the FAQ page renders", () => {
  const faq = readFileSync(fileURLToPath(new URL("../public/faq.md", import.meta.url)), "utf8");
  const answerTo = (prefix: string) =>
    renderToStaticMarkup(
      createElement("dd", null, renderBlocks(parseFaq(faq).find((e) => e.question.startsWith(prefix))!.answer)),
    );

  it("gives the security profiles a real list rather than a run-on line", () => {
    const html = answerTo("Which security profiles");
    expect(html).toContain("<p>Four.</p>");
    expect((html.match(/<li>/g) ?? []).length).toBe(4);
    expect(html).toContain("<code>thwip.yaml</code>");
    expect(html).not.toContain("- <b>");
  });

  it("keeps paragraph breaks in every answer that has them", () => {
    for (const entry of parseFaq(faq)) {
      const paragraphs = entry.answer.split(/\n{2,}/).filter((b) => b.trim() !== "").length;
      const html = renderToStaticMarkup(createElement("dd", null, renderBlocks(entry.answer)));
      expect((html.match(/<p>|<ul>/g) ?? []).length, entry.question).toBe(paragraphs);
    }
  });
});
