import { defineConfig } from "astro/config";
import markdoc from "@astrojs/markdoc";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://thwip.recall.net",
  integrations: [
    markdoc({ ignoreIndentation: true }),
    sitemap({
      filter: (page) => !page.endsWith(".md"),
    }),
  ],
  outDir: "dist",
  build: {
    format: "directory",
  },
});
