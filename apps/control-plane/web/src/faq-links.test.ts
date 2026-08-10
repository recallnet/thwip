import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFaq } from "./faq.js";

/**
 * A link into the FAQ that lands nowhere.
 *
 * The install page pointed at `/faq#signing-keys`, and a fragment that matches
 * no id scrolls to the top of the page instead of failing, so the link read as
 * working to everyone who wrote it and everyone who reviewed it. Nothing in the
 * FAQ had ever carried an id at all.
 *
 * This walks the source for FAQ fragments written as an href and holds every one
 * to a question the file actually asks, which is the only moment the mismatch is
 * cheap to see. Only hrefs: the first version read any occurrence in the text and
 * reported the comment above as a broken link.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const faq = readFileSync(fileURLToPath(new URL("../public/faq.md", import.meta.url)), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("links into the FAQ", () => {
  it("every fragment names a question the FAQ asks", () => {
    const slugs = new Set(parseFaq(faq).map((entry) => entry.slug));
    const linked = sources(here).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/href="\/faq#([a-z0-9-]+)"/g)].map((match) => ({ path, fragment: match[1]! }));
    });

    expect(linked.length, "no /faq# link found, so this test is checking nothing").toBeGreaterThan(0);
    for (const { path, fragment } of linked) {
      expect(slugs, `${path} links to /faq#${fragment}`).toContain(fragment);
    }
  });
});
