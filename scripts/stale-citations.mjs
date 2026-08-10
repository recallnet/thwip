/**
 * Find comments that send a reader to a file this repository does not have.
 *
 * The fourth member of the family `uncalled-exports.mjs`, `unwritten-fields.mjs`
 * and `unrendered-classes.mjs` cover, one level down from the code: something
 * that was true once and quietly stopped being true, in a form no reviewer can
 * see. A comment sending a reader to a design document, by name and section,
 * reads exactly the same after the document is deleted, and the only way to find
 * out is to go and look.
 *
 * Removing that document de-referenced about a hundred and ten citations by
 * hand, and six survived in file types the sweep's glob never opened. The same
 * thing happened twice in one afternoon this week: two comments explaining
 * themselves against a dashboard page the redesign had deleted.
 *
 * A citation has to name a **file**: it ends in an extension this repository
 * writes. Everything else that holds a slash is something else wearing the same
 * shape, and reporting those is how a check like this dies. Run against this
 * tree with only "has a slash" as the rule, it produced 162 findings of which
 * almost all were repository slugs (`recallnet/thwip`), HTTP routes
 * (`/v1/schema`), pinned action refs, and ordinary prose (`owners/admins`,
 * `lint/typecheck/test`). A check that is wrong that often is the argument
 * somebody uses for an allowlist.
 *
 * Markdown is left alone. A document is prose about the world, and it discusses
 * files this repository does not hold — a robots file managed at a CDN, a built
 * artifact — perfectly correctly. Code comments annotate this tree, which is
 * what makes a dead path in one a defect rather than a sentence.
 *
 * Relative module specifiers are left alone too. `./queue-state.js` is resolved
 * by the compiler, which is stricter than this and runs first, and its `.js`
 * naming an emitted `.ts` file is a rule this has no business relearning.
 *
 * There is no allowlist, for the reason written at length in
 * `uncalled-exports.mjs`. A citation that has to point at nothing is not a
 * citation: say the thing, or name something that exists.
 *
 * Migrations are read like everything else. An applied migration's SQL is
 * frozen but its comments are not, and a comment that sends somebody to a file
 * that has gone is no more useful there than anywhere else. Rewriting it to say
 * what was true at the time is the repair.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage", ".astro", "build"]);

/** Where comments worth checking live. */
const READ = /\.(ts|tsx|js|jsx|mjs|cjs|css|sql|yml|yaml)$/;

/** Extensions a citation may end in without needing a slash to prove itself. */
const EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|sql|md|ya?ml|json|jsonc|toml|sh|html|txt|lock|astro)$/;

/**
 * A path this repository would recognise.
 *
 * Anchored on characters a path can hold, then filtered: a candidate has to look
 * like a repository path rather than a URL, a package name, a glob, or an
 * English sentence that happens to contain a slash.
 */
const CANDIDATE = /(?:^|[\s(`'"[])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@*-]+)+|[\w.-]+\.[a-z]{1,6})(?=[\s)`'".,;:!?\]]|$)/g;

/** Comment text only. Code is checked by the compiler; prose is not checked by anything. */
export function commentsIn(source, path) {
  const lines = [];
  const sql = path.endsWith(".sql");
  const hash = /\.(ya?ml|sh)$/.test(path);
  let inBlock = false;
  source.split("\n").forEach((raw, i) => {
    const line = i + 1;
    let text = null;
    if (inBlock) {
      text = raw;
      if (raw.includes("*/")) inBlock = false;
    } else if (blockStart(raw) !== -1) {
      const at = blockStart(raw);
      text = raw.slice(at);
      if (!raw.slice(at).includes("*/")) inBlock = true;
    } else if (sql && raw.includes("--")) {
      text = raw.slice(raw.indexOf("--"));
    } else if (hash && raw.includes("#")) {
      text = raw.slice(raw.indexOf("#"));
    } else {
      const at = commentStart(raw);
      if (at !== -1) text = raw.slice(at);
    }
    if (text !== null) lines.push({ line, text });
  });
  return lines;
}

/**
 * Where a line comment begins, or -1.
 *
 * A `//` inside a string is not one, and neither is the one in a URL. Both
 * appear in this repository's own tests, which is where the naive version
 * reported a path out of a quoted example.
 */
function blockStart(raw) {
  return scan(raw, (c, next) => c === "/" && next === "*");
}

/** Where a line comment begins, ignoring anything inside a string. */
function commentStart(raw) {
  return scan(raw, (c, next, prev) => c === "/" && next === "/" && prev !== ":");
}

/** Walk a line outside its string literals, and report where `hit` first holds. */
function scan(raw, hit) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (hit(c, raw[i + 1], raw[i - 1])) return i;
  }
  return -1;
}

/** Things in this text that are shaped like a path in this repository. */
export function citationsIn(text) {
  const found = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const cited = raw.replace(/[.,;:]+$/, "");
    if (cited.length === 0) continue;
    // A file, or nothing. A slash alone is worn by too many other things.
    if (!EXTENSIONS.test(cited)) continue;
    // A pinned action, a scoped package, a glob, a URL.
    if (cited.includes("@") || cited.includes("*") || /^https?:/.test(cited)) continue;
    // The compiler resolves these, before this runs and more strictly.
    if (cited.startsWith("./") || cited.startsWith("../")) continue;
    // Something the build writes. Its absence from a clean tree says nothing
    // about whether the citation is good, and these are the same directories
    // this check declines to walk.
    if (cited.split("/").some((segment) => SKIP.has(segment) || segment.startsWith("dist"))) continue;
    found.push(cited);
  }
  return found;
}

/**
 * Whether the repository holds the thing a citation names.
 *
 * Tried against the root and against every directory between the root and the
 * citing file, because people write these from wherever they are standing:
 * `src/auth.ts` inside `apps/control-plane/src` means the one in this app, and
 * demanding a root-relative path would report most of the honest ones.
 */
export function resolves(root, fromPath, cited, names) {
  // A bare filename is a name rather than a location. "see candidate.ts" is
  // asking the reader to find the file, and it has done its job wherever the
  // file is; insisting it sit beside the comment would report most of the
  // honest ones.
  if (!cited.includes("/")) return names.has(cited);
  const parts = fromPath.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i -= 1) {
    if (existsSync(join(root, ...parts.slice(0, i), cited))) return true;
  }
  // A path written from partway down, `queue/candidate-verdict.ts` for a file
  // several directories deeper. It names one file unambiguously enough for a
  // reader to find it, which is all a citation has to do.
  return names.suffixes.has(cited) || [...names.paths].some((p) => p.endsWith(`/${cited}`));
}

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Every citation in the tree that names nothing. */
export function staleCitations({ root }) {
  const findings = [];
  const everything = walk(root, () => true);
  const relative = everything.map((p) => p.slice(root.length + 1));
  const names = new Set(relative.map((p) => p.slice(p.lastIndexOf("/") + 1)));
  names.paths = new Set(relative);
  names.suffixes = new Set(relative);
  for (const absolute of everything.filter((p) => READ.test(p))) {
    const path = absolute.slice(root.length + 1);
    const source = readFileSync(absolute, "utf8");
    for (const { line, text } of commentsIn(source, path)) {
      for (const cited of citationsIn(text)) {
        if (!resolves(root, path, cited, names)) findings.push({ path, line, cited });
      }
    }
  }
  return findings;
}

export function describe(findings) {
  return findings.map((f) => `${f.path}:${f.line} cites ${f.cited}`);
}
