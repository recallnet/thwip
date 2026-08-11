import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseBlocks, parseFaq, renderInline } from "./faq.js";

/**
 * Read the real file, not a fixture. A fixture would keep passing the day
 * someone edits `faq.md` and forgets the page again, which is the exact
 * drift this parser exists to close off.
 */
const faqPath = fileURLToPath(new URL("../public/faq.md", import.meta.url));
const faqSource = readFileSync(faqPath, "utf8");

describe("parseFaq", () => {
  it("finds every question the file has, in the order the file has them", () => {
    const headingCount = faqSource.split("\n").filter((line) => line.startsWith("## ")).length;
    const entries = parseFaq(faqSource);

    expect(entries).toHaveLength(headingCount);
    expect(entries.map((entry) => entry.question)).toEqual([
      "Can someone fake a proof?",
      "Does thwip watch my tests?",
      "What if some checks must run in GitHub?",
      "How does this relate to SLSA?",
      "Which security profiles can I pick?",
      "What does a proof actually prove?",
      "How does a teammate join?",
      "How do I express a build matrix, services, or several platforms?",
      "Where do signing keys come from?",
      "Do commits have to be signed?",
      "What happens on a rebase or squash?",
      "Where do project settings live?",
      "Who publishes the required proof check?",
      "Why are there two required checks?",
      "What data does the control plane hold?",
    ]);
  });

  // The page used to be a hand-typed second copy of this file and fell two
  // questions behind it. Naming them here means a future drift fails a test
  // instead of waiting for someone to notice the page is short.
  it("carries the two questions the hard-coded page had dropped", () => {
    const questions = parseFaq(faqSource).map((entry) => entry.question);

    expect(questions).toContain("How do I express a build matrix, services, or several platforms?");
    expect(questions).toContain("Why are there two required checks?");
  });

  it("discards the title and lede above the first heading", () => {
    const entries = parseFaq(faqSource);

    expect(entries.every((entry) => !entry.question.includes("thwip FAQ"))).toBe(true);
  });
});

describe("renderInline", () => {
  it("turns inline code into a code element rather than leaving the backticks", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, ...renderInline("Run `thwip run` to see it.")));

    expect(html).toContain("<code>thwip run</code>");
    expect(html).not.toContain("`");
  });

  it("turns bold spans into a bold element rather than leaving the asterisks", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, ...renderInline("**fast**: a signed local proof.")));

    expect(html).toContain("<b>fast</b>");
    expect(html).not.toContain("**");
  });

  it("renders every inline code span the security-profiles answer actually has", () => {
    const answer = parseFaq(faqSource).find((entry) => entry.question === "Which security profiles can I pick?");
    expect(answer).toBeDefined();

    const html = renderToStaticMarkup(createElement(Fragment, null, ...renderInline(answer!.answer)));

    expect(html).toContain("<b>fast</b>");
    expect(html).toContain("<b>remote</b>");
    expect(html).toContain("<b>fresh</b>");
    expect(html).toContain("<b>audited</b>");
    expect(html).toContain("<code>thwip.yaml</code>");
  });
});

// The page rendered every answer as one run-on line: no white-space rule
// carries a bare "\n" into a break, so a bulleted answer read as "Four. -
// fast: ... - remote: ..." with the paragraph and list boundaries gone.
// These pin the block shape a reader actually sees.
describe("parseBlocks", () => {
  it("splits the security-profiles answer into a paragraph, a four-item list, and a paragraph", () => {
    const answer = parseFaq(faqSource).find((entry) => entry.question === "Which security profiles can I pick?");
    expect(answer).toBeDefined();

    const blocks = parseBlocks(answer!.answer);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "paragraph", text: "Four, from least to most independent evidence." });
    expect(blocks[1]?.kind).toBe("list");
    expect(blocks[1]?.kind === "list" ? blocks[1].items : []).toHaveLength(4);
    expect(blocks[2]?.kind).toBe("paragraph");
  });

  it("joins a bullet's wrapped continuation lines into its own item rather than a separate one", () => {
    const answer = parseFaq(faqSource).find((entry) => entry.question === "Which security profiles can I pick?");
    const blocks = parseBlocks(answer!.answer);
    const list = blocks[1];
    expect(list?.kind).toBe("list");
    if (list?.kind !== "list") return;

    expect(list.items[0]).toBe(
      "**fast**: reuse the signed proof on the pull-request head. Do not run the integrated candidate again.",
    );
    expect(list.items).toHaveLength(4);
  });

  it("joins a paragraph's wrapped lines into one line", () => {
    const answer = parseFaq(faqSource).find((entry) => entry.question === "Does thwip watch my tests?");
    expect(answer).toBeDefined();

    const blocks = parseBlocks(answer!.answer);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("paragraph");
    expect(blocks[0]?.kind === "paragraph" ? blocks[0].text : "").not.toContain("\n");
  });
});

describe("FAQ accuracy guardrails", () => {
  function answer(question: string): string {
    const entry = parseFaq(faqSource).find((candidate) => candidate.question === question);
    expect(entry, question).toBeDefined();
    return entry!.answer;
  }

  it("separates local execution from control-plane verification", () => {
    const text = answer("Does thwip watch my tests?");

    expect(text).toContain("The CLI runs the approved suite commands on your machine");
    expect(text).toContain("The control plane does not run repository code or read test logs");
    expect(text).not.toContain("thwip never sees your code and runs nothing");
  });

  it("does not claim a SLSA level the candidate workflow does not establish", () => {
    const text = answer("How does this relate to SLSA?");

    expect(text).toContain("does not currently claim a SLSA level");
    expect(text).toContain("does not create or distribute SLSA provenance");
    expect(text).not.toContain("is SLSA Build L3");
  });

  it("states that the control plane retains public keys and authentication records", () => {
    expect(answer("Where do signing keys come from?")).toMatch(
      /stores its\s+public value and fingerprint for verification and audit/,
    );
    expect(answer("What data does the control plane hold?")).toContain("encrypted GitHub OAuth");
  });
});
