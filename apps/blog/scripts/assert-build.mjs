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
if (existsSync(blogDir)) {
  const entries = readdirSync(blogDir, { withFileTypes: true });
  const postDirs = entries.filter((e) => e.isDirectory() && e.name !== "_astro");
  if (postDirs.length === 0) {
    failures.push("no post directories under blog/");
  } else {
    for (const dir of postDirs) {
      const postIndex = join(blogDir, dir.name, "index.html");
      if (!existsSync(postIndex)) {
        failures.push(`missing blog/${dir.name}/index.html`);
      }
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

if (failures.length > 0) {
  console.error("blog assert-build failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("blog assert-build ok");
