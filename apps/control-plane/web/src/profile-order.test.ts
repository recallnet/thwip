import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROFILES } from "./Home.js";

/**
 * `Home.tsx` sorts `PROFILES` weakest to strongest and renders that order as
 * strength dots, so the sequence is load-bearing there. faq.md and llms.txt
 * used to list the same four profiles in a different order (fast, remote,
 * fresh, audited) with no dots to justify it, so a reader who met them on the
 * homepage and then the FAQ saw a different sequence for no reason. This
 * pins the one list each surface exists to give a reader.
 */

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

function firstMentionOrder(text: string, names: readonly string[]): string[] {
  const positions = names
    .map((name) => ({ name, index: text.search(new RegExp(`\\b${name}\\b`, "i")) }))
    .filter(({ index }) => index !== -1)
    .sort((a, b) => a.index - b.index);
  return positions.map(({ name }) => name);
}

/**
 * Scoped to the bulleted answer rather than the whole FAQ. An earlier answer names
 * two of the four profiles in passing, and a document-wide scan would judge
 * this file by a sentence that is not the profile list at all.
 */
function faqProfileList(faq: string): string {
  const heading = "## Which security profiles can I pick?";
  const start = faq.indexOf(heading);
  if (start === -1) throw new Error(`faq.md: heading ${JSON.stringify(heading)} not found`);
  const bodyStart = start + heading.length;
  const nextHeading = faq.indexOf("\n## ", bodyStart);
  const body = faq.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading);
  const bullets = [...body.matchAll(/^- \*\*(\w+)\*\*:/gm)];
  if (bullets.length === 0) throw new Error("faq.md: no `- **name**:` bullets found under the profiles heading");
  return bullets.map((m) => m[1]).join(" ");
}

/**
 * Scoped to the one sentence that lists the profiles: llms.txt otherwise
 * mentions "remote" and "fast" again later while describing what a proof
 * establishes, which is not the list this test is guarding.
 */
function llmsTxtProfileList(llmsTxt: string): string {
  const marker = "Security profiles per project:";
  const start = llmsTxt.indexOf(marker);
  if (start === -1) throw new Error(`llms.txt: marker ${JSON.stringify(marker)} not found`);
  const end = llmsTxt.indexOf("\n\n", start);
  if (end === -1) throw new Error("llms.txt: profile-list paragraph never ends (no blank line found)");
  return llmsTxt.slice(start, end);
}

describe("profile order", () => {
  const expected = PROFILES.map((profile) => profile.name);

  it("lists profiles in faq.md's profile answer in the same order Home.tsx assigns strength", () => {
    const faq = readFileSync(`${publicDir}faq.md`, "utf8");
    expect(firstMentionOrder(faqProfileList(faq), expected)).toEqual(expected);
  });

  it("lists profiles in llms.txt's profile sentence in the same order Home.tsx assigns strength", () => {
    const llmsTxt = readFileSync(`${publicDir}llms.txt`, "utf8");
    expect(firstMentionOrder(llmsTxtProfileList(llmsTxt), expected)).toEqual(expected);
  });
});
