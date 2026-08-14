import { defineConfig } from "astro/config";
import markdoc from "@astrojs/markdoc";
import sitemap from "@astrojs/sitemap";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientOutput = fileURLToPath(new URL("../control-plane/dist/client", import.meta.url));
const verifyOutput = {
  name: "manage-blog-output",
  hooks: {
    "astro:build:start": () => {
      // A standalone blog rebuild must remove pages that no longer exist,
      // without deleting the application files that share this directory.
      for (const path of ["blog", "_astro", "rss.xml", "sitemap-index.xml", "sitemap-0.xml"]) {
        rmSync(`${clientOutput}/${path}`, { recursive: true, force: true });
      }
    },
    "astro:build:done": ({ dir }) => {
      const root = fileURLToPath(dir);
      const required = ["index.html", "install.md", "assets", "blog/index.html", "rss.xml", "blog/beta-hero.svg", "blog/install-hero.svg"];
      for (const path of required) {
        if (!existsSync(`${root}/${path}`)) throw new Error(`blog build is missing ${path}`);
      }
      const index = readFileSync(`${root}/blog/index.html`, "utf8");
      if (!index.includes("eb-index-title") || index.includes('id="root"')) {
        throw new Error("blog index was replaced by the application shell");
      }
      const feed = readFileSync(`${root}/rss.xml`, "utf8");
      if (!feed.includes("<rss") && !feed.includes("<feed")) throw new Error("rss.xml is not a feed");
      if (!readFileSync(`${root}/index.html`, "utf8").includes('id="root"')) {
        throw new Error("blog build replaced the application shell");
      }
    },
  },
};

export default defineConfig({
  site: "https://thwip.ai",
  output: "static",
  // Astro 7 defaults to JSX whitespace. Keep the site's prior HTML-aware spacing.
  compressHTML: true,
  integrations: [
    markdoc({ ignoreIndentation: true }),
    sitemap({
      filter: (page) => !page.endsWith(".md"),
    }),
    verifyOutput,
  ],
  outDir: "../control-plane/dist/client",
  vite: { build: { emptyOutDir: false } },
  build: {
    format: "directory",
  },
});
