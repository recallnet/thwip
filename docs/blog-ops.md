# Blog ops notes

Operational checklist for the product blog on `thwip.recall.net`. Not a deploy
script.

## Cloudflare crawl policy

The Worker serves the blog as static assets under the same zone as the SPA.

1. Open Cloudflare for the zone that fronts `thwip.recall.net`.
2. Review **AI Crawl Control** / managed `robots.txt`. A managed file that
   `Disallow: /` for GPTBot, ClaudeBot, PerplexityBot, and OAI-SearchBot will
   hide the blog from AI search products even when the app is public.
3. Prefer allowing **retrieval / search** bots used for citations and blocking
   training-only crawlers only if product wants that split. Document the choice
   in the dashboard comments when you change it.
4. Confirm the zone does not block known AI bot IPs at the WAF in a way that
   overrides `robots.txt`.

## Markdown for Agents

If the plan includes Cloudflare **Markdown for Agents**, enable it for the zone
so clients that send `Accept: text/markdown` get HTML→markdown at the edge.
First-party `/blog/<slug>.md` twins remain the source of truth for agents that
fetch explicit paths.

## Search Console

After the first production deploy that includes `/blog`:

1. Verify `thwip.recall.net` in Google Search Console if not already.
2. Submit or refresh the sitemap (`/sitemap-index.xml`).
3. Use the Generative AI performance report later to see AI Overview / AI Mode
   visibility for blog URLs.

## Authoring

New posts: add `apps/blog/src/content/blog/<id>.mdoc` with required frontmatter.
New UI patterns: add a Markdoc tag in `apps/blog/markdoc.config.mjs` and a
component under `apps/blog/src/components/`. Do not invent a second MD pipeline.
