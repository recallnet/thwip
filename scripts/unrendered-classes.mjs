/**
 * Find classes this repository styles and no markup it ships ever renders.
 *
 * This is the CSS member of the family `uncalled-exports.mjs` and
 * `unwritten-fields.mjs` already cover: work that is written, reviewed,
 * carefully maintained, and reachable by nothing. A reviewer cannot see it,
 * because the rule is well-formed and the file it lives in is the right file.
 * The only missing thing is the one line of markup that would name it.
 *
 * It found seventeen on the day it was written: the whole pricing-plan block,
 * a hero, a step list, a stamp, a slip and a footer. One of them,
 * `.thwip-plan__price`, had been through the palette migration and come out
 * the other side set in Archivo at wdth 125 with tabular numerals, for a price
 * tag no page has ever drawn.
 *
 * There is no allowlist, for the reason written at length in
 * `uncalled-exports.mjs`: an entry costs one line, its reason is written once
 * and never reread, and the list outlives every finding it was meant to
 * shrink. A class that must exist without markup does not exist. Delete the
 * rule; git keeps it.
 *
 * The check reads only the stylesheets this repository writes. A library's own
 * classes are its business, and the rules here that restyle one are reached
 * through the markup that renders it, which is the markup this check reads.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where a rule can hang off something other than a class. */
const NOT_A_CLASS = /^(?:@|:root|from\b|to\b|\d)/;

/**
 * Every class a selector list depends on.
 *
 * A rule is reached through the classes written in it, so `.a:hover .b::before`
 * needs both `a` and `b`. Reading the state or the pseudo-element as a name of
 * its own would report every hover of a class that renders perfectly well.
 */
export function classesIn(selectorList) {
  if (NOT_A_CLASS.test(selectorList.trim())) return [];
  return [...selectorList.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/**
 * Every name the markup could be asking for.
 *
 * Tokenised rather than parsed, so a class assembled in a template literal or
 * chosen by a conditional counts as a use. The cost of that is a class named by
 * a string that happens to match something unrelated, which under-reports. This
 * check is worth having only if a finding is always real.
 */
export function namesIn(source) {
  return new Set(source.match(/-?[_a-zA-Z][\w-]*/g) ?? []);
}

export function unrenderedClasses({ styles, sources }) {
  const rendered = new Set();
  // A token left hanging on a separator is a name an interpolation finishes,
  // so it stands for every class that can start that way.
  const prefixes = [];
  for (const { text } of sources) {
    for (const name of namesIn(text)) {
      rendered.add(name);
      if (name.endsWith("-") || name.endsWith("_")) prefixes.push(name);
    }
  }
  const isRendered = (className) =>
    rendered.has(className) || prefixes.some((prefix) => className.startsWith(prefix));

  const findings = [];
  const seen = new Set();
  for (const { path, text } of styles) {
    // Comments carry example markup and prose full of dotted words.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const match of stripped.matchAll(/(^|[};])([^{};]*)\{/g)) {
      const line = stripped.slice(0, match.index).split("\n").length;
      for (const className of classesIn(match[2])) {
        if (isRendered(className) || seen.has(className)) continue;
        seen.add(className);
        findings.push({ className, path, line });
      }
    }
  }
  return findings;
}

export function describe(findings) {
  return findings.map((f) => `${f.path}:${f.line} .${f.className}`);
}

function walk(dir, test, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, test, out);
    else if (test(path)) out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

const MARKUP = /\.(tsx?|jsx?|astro|html|md|mdoc)$/;

/**
 * One app at a time.
 *
 * The control plane's stylesheets are answered by the control plane's markup,
 * and the blog's by the blog's. Pooling them would let a class survive in one
 * app because an unrelated word appears in the other.
 */
export function unrenderedClassesInRepo({ root, apps = ["apps/control-plane", "apps/blog"] }) {
  const findings = [];
  for (const app of apps) {
    const dir = join(root, app);
    findings.push(
      ...unrenderedClasses({
        styles: walk(dir, (p) => p.endsWith(".css")).map((f) => ({ ...f, path: f.path.slice(root.length + 1) })),
        sources: walk(dir, (p) => MARKUP.test(p)),
      }),
    );
  }
  return findings;
}
