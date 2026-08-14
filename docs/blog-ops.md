# Blog ops notes

Operational checklist for the product blog on `thwip.ai`. Not a deploy
script.

## Cloudflare crawl policy

The Worker serves the blog as static assets under the same zone as the SPA.

1. Open Cloudflare for the zone that fronts `thwip.ai`.
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

For each material blog release:

1. Confirm `thwip.ai` remains verified in Google Search Console.
2. Confirm the sitemap index (`/sitemap-index.xml`) is submitted and readable.
3. Review crawl errors and search visibility for the changed URLs.

## Authoring

New posts: add `apps/blog/src/content/blog/<id>.mdoc` with required frontmatter.
New UI patterns: add a Markdoc tag in `apps/blog/markdoc.config.mjs` and a
component under `apps/blog/src/components/`. Do not invent a second MD pipeline.
