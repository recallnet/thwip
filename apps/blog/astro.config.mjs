import { defineConfig } from "astro/config";
import markdoc from "@astrojs/markdoc";
import sitemap from "@astrojs/sitemap";

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
  ],
  outDir: "dist",
  build: {
    format: "directory",
  },
});
