import { createElement, type ReactNode } from "react";

/**
 * The FAQ used to live twice: once as `public/faq.md`, the file agents are
 * told to read, and once as hand-typed `<dt>`/`<dd>` pairs in `App.tsx`. The
 * two drifted apart. The page fell two questions behind the file, and it
 * shortened a third answer, because nothing forced an edit to one to touch
 * the other. `faq.md` is now the only place a question or an answer is
 * written; this module turns its bytes into what `FaqPage` renders.
 */

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
  /**
   * The id the question is rendered with, so other pages can link to one.
   *
   * The install page pointed at `/faq#signing-keys` and landed at the top of
   * the FAQ, because nothing here had ever put an id on anything. A fragment
   * that resolves to nothing looks identical to one that works until somebody
   * clicks it.
   */
  readonly slug: string;
}

/** A question as a fragment: lower case, words joined by dashes. */
export function faqSlug(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `## ` starts a question; everything up to the next `## ` (or the end of
 * the file) is its answer, trimmed. Text before the first `## ` is the
 * document's own title and lede, addressed to someone reading the raw file,
 * not a question, so it is discarded here.
 */
export function parseFaq(source: string): FaqEntry[] {
  const sections = source.split(/^## /m).slice(1);
  return sections.map((section) => {
    const newline = section.indexOf("\n");
    const question = (newline === -1 ? section : section.slice(0, newline)).trim();
    const answer = (newline === -1 ? "" : section.slice(newline + 1)).trim();
    return { question, answer, slug: faqSlug(question) };
  });
}

/**
 * The only markdown spans `faq.md` actually uses: `` `code` `` for names like
 * `thwip.yaml`, and `**bold**` for the profile names in the security-profiles
 * answer. There are no links in the file, so none are handled here. Adding
 * that parsing now would be for a case that has never occurred.
 */
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [, code, bold] = match;
    if (code !== undefined) {
      nodes.push(createElement("code", { key: key++ }, code));
    } else {
      nodes.push(createElement("b", { key: key++ }, bold));
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export type FaqBlock = { readonly kind: "paragraph"; readonly text: string } | { readonly kind: "list"; readonly items: readonly string[] };

/**
 * `faq.md` wraps its prose at a line width and indents a bulleted item's
 * continuation lines by two spaces rather than repeating `- `, so a line
 * starting `- ` opens an item and every line after it belongs to that item
 * until the next `- ` or the block ends. A block is a list when its first
 * line opens one; every other block is one paragraph, its wrapped lines
 * rejoined with single spaces. Nested lists, ordered lists, headings inside
 * an answer, and code blocks do not appear in the file, so none are parsed.
 */
export function parseBlocks(answer: string): FaqBlock[] {
  const blocks = answer.split(/\n{2,}/).map((block) => block.trim());
  return blocks.map((block): FaqBlock => {
    const lines = block.split("\n").map((line) => line.trim());
    if (!lines[0]?.startsWith("- ")) {
      return { kind: "paragraph", text: lines.join(" ") };
    }
    const items: string[] = [];
    for (const line of lines) {
      if (line.startsWith("- ")) {
        items.push(line.slice(2));
      } else {
        items[items.length - 1] = `${items[items.length - 1]} ${line}`;
      }
    }
    return { kind: "list", items };
  });
}

/** The block nodes an answer's `<dd>` renders: a run of `<p>` and `<ul>` elements, with `renderInline` applied inside each. */
export function renderBlocks(answer: string): ReactNode[] {
  return parseBlocks(answer).map((block, index) => {
    if (block.kind === "paragraph") {
      return createElement("p", { key: index }, renderInline(block.text));
    }
    return createElement(
      "ul",
      { key: index },
      block.items.map((item, itemIndex) => createElement("li", { key: itemIndex }, renderInline(item))),
    );
  });
}
