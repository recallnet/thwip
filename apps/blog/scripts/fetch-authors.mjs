/**
 * Refresh the GitHub half of the author registry.
 *
 * GitHub owns what GitHub knows: the avatar, the profile URL, the linked
 * accounts, the employer. We own the display name, the job title, the bio and
 * the topic list, because a GitHub bio is one line of prose with @-handles in
 * it and no profile carries a job title at all.
 *
 * The result is committed, so the site build reads a file instead of calling
 * out to github.com while it renders.
 *
 * Usage: node scripts/fetch-authors.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const registryPath = join(dirname(fileURLToPath(import.meta.url)), "../src/data/authors.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

/**
 * People list their site on GitHub however they typed it, and a plain http URL
 * in sameAs is a downgrade. Upgrade it when the secure origin answers.
 */
async function secureUrl(url) {
  if (!url || !url.startsWith("http://")) return url || null;
  const https = url.replace(/^http:\/\//, "https://");
  const probe = await fetch(https, { method: "HEAD", redirect: "follow" }).catch(() => null);
  return probe?.ok ? https : url;
}

for (const [key, author] of Object.entries(registry)) {
  if (author.kind !== "person") continue;

  const response = await fetch(`https://api.github.com/users/${author.login}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "thwip-blog" },
  });
  if (!response.ok) {
    console.error(`${key}: GitHub returned ${response.status}`);
    process.exit(1);
  }
  const profile = await response.json();

  // GitHub's company field is free text and usually a string of @-handles, so
  // the employer name stays a local field. Everything here is machine-readable.
  author.github = {
    htmlUrl: profile.html_url,
    avatarUrl: profile.avatar_url,
    blog: await secureUrl(profile.blog),
    twitter: profile.twitter_username ?? null,
  };
  console.log(`${key}: refreshed from github.com/${author.login}`);
}

writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`wrote ${registryPath}`);
