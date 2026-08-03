/**
 * Copy Astro output into the control-plane client asset tree so the Worker
 * serves /blog, /rss.xml, and sitemaps from the same origin as the SPA.
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "dist");
const client = join(root, "../control-plane/dist/client");

if (!existsSync(from)) {
  console.error("blog dist missing; run astro build first");
  process.exit(1);
}
if (!existsSync(client)) {
  console.error("control-plane dist/client missing; build the SPA before merging the blog");
  process.exit(1);
}

cpSync(from, client, { recursive: true });
console.log("merged blog dist into control-plane/dist/client");
