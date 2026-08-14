/**
 * Fail the monorepo build if blog artifacts never landed in the SPA asset tree.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(root, "../control-plane/dist/client");

const failures = [];

function requireFile(rel) {
  const path = join(client, rel);
  if (!existsSync(path)) failures.push(`missing ${rel}`);
  return path;
}

const indexPath = requireFile("blog/index.html");
const rssPath = requireFile("rss.xml");

if (indexPath && existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes('meta name="description"') && !html.includes("name=\"description\"")) {
    failures.push("blog/index.html lacks a description meta tag");
  }
}

const blogDir = join(client, "blog");

/** Directories under blog/ that hold a post, rather than assets or author pages. */
function postDirNames() {
  if (!existsSync(blogDir)) return [];
  const skip = new Set(["_astro", "authors"]);
  return readdirSync(blogDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !skip.has(e.name))
    .map((e) => e.name);
}

const postDirs = postDirNames();
if (existsSync(blogDir)) {
  if (postDirs.length === 0) {
    failures.push("no post directories under blog/");
  }
  for (const name of postDirs) {
    if (!existsSync(join(blogDir, name, "index.html"))) {
      failures.push(`missing blog/${name}/index.html`);
    }
  }
}

if (rssPath && existsSync(rssPath)) {
  const rss = readFileSync(rssPath, "utf8");
  if (!rss.includes("<rss") && !rss.includes("<feed")) {
    failures.push("rss.xml does not look like a feed");
  }
}

// Hero assets referenced from posts must ship next to the HTML.
for (const asset of ["blog/beta-hero.svg", "blog/install-hero.svg"]) {
  requireFile(asset);
}

// SPA-style shell must not replace the blog index (regression guard).
if (indexPath && existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes("eb-index-title") || html.includes("id=\"root\"")) {
    failures.push("blog/index.html looks like the SPA shell, not the editorial index");
  }
}

/** Pull every JSON-LD block out of a built page. */
function structuredData(html) {
  const blocks = [];
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const parsed = JSON.parse(match[1]);
    blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return blocks;
}

// Author attribution. A byline has to name someone accountable and resolve to a
// crawlable page, and the Person entity behind it has to carry the properties a
// reader (or a rater) needs to check who wrote this.
const bylineAuthors = new Set();

for (const name of postDirs) {
  const postIndex = join(blogDir, name, "index.html");
  if (!existsSync(postIndex)) continue;
  const html = readFileSync(postIndex, "utf8");
  const posting = structuredData(html).find((b) => b["@type"] === "BlogPosting");
  if (!posting) {
    failures.push(`blog/${name} has no BlogPosting JSON-LD`);
    continue;
  }

  const accountable = posting.author?.["@type"] === "Person" ? posting.author : posting.reviewedBy;
  if (!accountable || accountable["@type"] !== "Person") {
    failures.push(`blog/${name} names no accountable Person as author or reviewer`);
    continue;
  }
  for (const property of ["@id", "name", "url", "image", "sameAs"]) {
    if (!accountable[property]) {
      failures.push(`blog/${name} accountable Person lacks ${property}`);
    }
  }
  if (accountable.url) bylineAuthors.add(accountable.url);

  // The visible byline must reach the same page the structured data points at,
  // or the markup and the schema disagree about who wrote this.
  if (accountable.url && !html.includes(new URL(accountable.url).pathname)) {
    failures.push(`blog/${name} byline does not link to ${accountable.url}`);
  }
}

if (bylineAuthors.size === 0) {
  failures.push("no post exposes an accountable author");
}

for (const url of bylineAuthors) {
  const rel = join("blog", new URL(url).pathname.replace(/^\/blog\//, ""), "index.html");
  const path = join(client, rel);
  if (!existsSync(path)) {
    failures.push(`missing author page ${rel}`);
    continue;
  }
  const html = readFileSync(path, "utf8");
  const profile = structuredData(html).find((b) => b["@type"] === "ProfilePage");
  if (!profile) {
    failures.push(`${rel} has no ProfilePage JSON-LD`);
    continue;
  }
  const person = profile.mainEntity;
  if (!person || person["@type"] !== "Person") {
    failures.push(`${rel} ProfilePage has no Person mainEntity`);
    continue;
  }
  for (const property of ["@id", "name", "jobTitle", "url", "image", "description", "sameAs"]) {
    if (!person[property]) failures.push(`${rel} Person lacks ${property}`);
  }
  if (Array.isArray(person.sameAs) && person.sameAs.length === 0) {
    failures.push(`${rel} Person has an empty sameAs`);
  }
}

if (failures.length > 0) {
  console.error("blog assert-build failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("blog assert-build ok");
