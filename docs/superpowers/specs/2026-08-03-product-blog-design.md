# Product Blog Design

**Date:** 2026-08-03  
**Status:** Approved for planning  
**Domain:** `https://thwip.recall.net` (same origin; no subdomain)

## Problem

thwip needs a production product blog for authority and growth. First posts are the beta launch announcement and a beta sign-up / install tutorial. Content must live in git as Markdown-class files with frontmatter, ship as static HTML on the existing Cloudflare Worker asset origin, reuse notary brand tokens in an editorial layout, and stay highly discoverable by humans, classic search, and AI agents.

We will not build a blogging product or a custom Markdown pipeline. Libraries own content, rendering, RSS, and sitemaps. This repo only supplies layout, brand CSS, a small Markdoc tag map, two posts, and deploy glue.

## Goals

1. **Editorial quality** comparable to Vercel / Railway blogs: hero art, wide reading column, syntax-highlighted code with copy, product shots, clear CTAs.
2. **One brand system, two layouts:** notary palette and type (Public Sans, Archivo, IBM Plex Mono) from the existing site; new editorial layout, not dashboard chrome.
3. **Same origin:** `thwip.recall.net/blog` and `/blog/<slug>` via static files in the Worker assets directory.
4. **AI + SEO discoverability** without GEO theater: real HTML, feeds, indexes agents already use, dual MD where useful.
5. **Minimal code:** Astro + Markdoc + official plugins. No CMS, comments, search index, or hand-rolled remark stack in v1.

## Non-goals (v1)

- Subdomain or separate marketing host
- Custom MD/MDX renderer or content CMS
- Migrating FAQ/Install off the React SPA (optional follow-up)
- Next.js / Vercel-hosted blog
- Training-bot policy product (document CF bot settings; do not invent a crawler framework)
- Newsletter, comments, full-text search
- Perfect Expressive Code + Markdoc integration if it fights the stack (prefer Markdoc’s Shiki path)

## Constraints (repo facts)

| Constraint | Implication |
|------------|-------------|
| Vite React SPA + Hono Worker, assets at `apps/control-plane/dist/client` | Blog must emit static files into that tree (or a known subpath) before deploy |
| `not_found_handling: single-page-application` | Real `blog/**/index.html` files are required so crawlers never get the SPA shell for posts |
| `pnpm-workspace` sets `sharp: false` | Prefer plain `<img>` / public assets for v1 product shots unless sharp is explicitly enabled for the blog package |
| Existing `llms.txt`, `/faq.md`, `/install.md` | Blog must extend that agent surface, not replace it |
| Graphics Press + `skin.css` tokens | Shared CSS variables; blog layout is new CSS, not a GP dashboard clone |

## Architecture

```
thwip/
  apps/
    blog/                         # Astro static site (content app)
      package.json                # @thwip/blog
      astro.config.mjs
      markdoc.config.mjs
      public/                     # static images, robots if needed
      src/
        content.config.ts         # content collections + Zod
        content/blog/*.mdoc       # posts (Markdoc)
        components/               # layout + Markdoc tag targets
        layouts/BlogLayout.astro
        pages/
          blog/index.astro
          blog/[...slug].astro
          blog/[...slug].md.ts    # optional raw MD twin
          rss.xml.ts
        styles/
          tokens.css              # mirrored / imported notary tokens
          editorial.css
    control-plane/                # existing Worker + Vite SPA
  # Root pnpm build runs @thwip/blog then control-plane (or blog outDir into client)
```

**Runtime**

- Humans hit static HTML under `/blog`.
- Worker needs no new blog API routes if files exist under the assets binding.
- Dashboard SPA remains Vite; blog is not client-routed through `App.tsx`.
- Nav links: add Blog to site bar/foot on both SPA public pages and Astro layout (hardcoded anchors).

**Libraries (authoritative)**

| Concern | Library |
|---------|---------|
| SSG, routing, HTML | Astro (static output) |
| Authoring + component map | `@astrojs/markdoc` (`.mdoc` + tags) |
| Frontmatter schema | Astro Content Collections + Zod |
| Syntax highlight | `@astrojs/markdoc/shiki` (official) |
| Code copy | Small layout script or Shiki transformer; not a custom highlighter |
| RSS | `@astrojs/rss` |
| Sitemap | `@astrojs/sitemap` |
| Styles | Hand CSS on shared tokens |

## Content model

### Collection: `blog`

Frontmatter (Zod):

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Page H1 / OG title |
| `description` | string | Meta + feed summary + list lede |
| `pubDate` | date | Required |
| `updatedDate` | date? | Optional |
| `author` | string | Display name; v1 single author or fixed list |
| `heroImage` | string? | Path under `public/` or content-relative |
| `heroAlt` | string? | Required if heroImage set |
| `tags` | string[] | e.g. `product`, `guide` |
| `draft` | boolean | default `false`; drafts excluded from prod build / feeds |
| `canonicalPath` | string? | Override if needed |

Slug = collection id (filename without extension), e.g. `beta`, `beta-install`.

### Markdoc tags (fixed map)

| Tag | Purpose |
|-----|---------|
| `callout` | Tip / warning / note |
| `cta` | Primary/secondary button row (href + label) |
| `product-shot` | Figure with image, alt, optional caption |
| `steps` / `step` | Numbered tutorial steps (install post) |

No free-form React in posts. New UI requires a new tag entry in `markdoc.config.mjs`.

### First posts (content deliverables)

1. **Beta release** — what thwip is, what beta includes, proof model in plain language, link to install + dashboard.
2. **Beta sign-up + install tutorial** — account, device key, `thwip` CLI, first proof path; copy-paste commands; product shots of dashboard / agent flow where real UI exists.

Copywriting is part of implementation, not this architecture doc. Posts must be non-commodity (Google’s bar): thwip-specific claims, not generic “7 CI tips.”

## Page design (editorial)

**Index `/blog`**

- Site bar (mark + FAQ / Install / Blog / Dashboard)
- Title + short lede
- Card list: hero thumb or date, title, description, tags
- Foot with RSS + llms.txt

**Post `/blog/<slug>`**

- Site bar
- Article header: title, description, author, dates, tags
- Optional full-width hero
- Prose column (~65–72ch), comfortable measure
- Fenced code with language label + copy control
- Mid/end CTAs via `{% cta %}`
- Related: link to the other post and `/install`
- JSON-LD `BlogPosting` + `BreadcrumbList`
- `<link rel="alternate" type="application/rss+xml">` and optional alternate for markdown twin

Visual language: paper/ink/civic tokens from `skin.css`; mono for code; no dark marketing gradient unless tokens already support it. Match the homepage’s notary seriousness more than Vercel’s black chrome, while keeping Vercel/Railway *structure* (hero, hierarchy, code polish).

## Discoverability and “AI SEO”

### What we do (evidence-based)

Per Google’s generative AI search guidance (2026): foundational SEO, crawlable HTML, unique people-first content. Google does not use `llms.txt` for ranking; we keep it for agents and other tools.

| Surface | Implementation |
|---------|----------------|
| Static HTML posts | Astro `output: 'static'` |
| Per-page title, description, canonical, OG/Twitter | `BlogLayout` from frontmatter |
| JSON-LD | `BlogPosting`, site `Organization`/`WebSite` on index |
| `sitemap-index` / pages | `@astrojs/sitemap`, `site: https://thwip.recall.net` |
| RSS | `/rss.xml` via `@astrojs/rss` |
| `llms.txt` | Extend existing file with Blog section + post links (and `.md` twins if present) |
| Markdown twins | Prefer `/blog/<slug>.md` (source or stripped body) so agents can fetch without HTML; mirrors Vercel’s pattern and existing `/faq.md` |
| `robots.txt` | Explicit allow of public routes; disallow `/api/`, `/v1/` if needed; **do not** rely on Cloudflare managed robots that blanket-block AI search bots without review |
| CF Markdown for Agents | Enable at zone level when plan allows (edge HTML→MD on `Accept: text/markdown`); complements first-party `.md`, does not replace it |
| Semantic HTML | Real headings, lists, `figure`/`figcaption`, anchors |

### What we skip as theater

- Fake “GEO chunking” pages
- Keyword-stuffed long-tail clones
- Schema spam (only mark up real post/Q&A content)
- Treating `llms.txt` as a Google ranking lever

### Bot policy (ops, not code)

Document in the plan: audit Cloudflare AI Crawl Control / managed robots so retrieval bots used for ChatGPT/Perplexity/Claude search are not globally `Disallow: /` while training-only bots can be restricted if product wants that split.

## Build and deploy

1. `pnpm --filter @thwip/blog build` produces static files.
2. Output lands at `apps/control-plane/dist/client/blog/**`, plus root-level `rss.xml` and sitemap files under `dist/client/` (configure `astro.config` `outDir` / postbuild copy).
3. Control-plane Vite build must **not** wipe blog artifacts: either  
   - build blog *after* Vite and merge, or  
   - Vite `emptyOutDir` careful sequencing: SPA first, then blog into same `dist/client` without emptying.  
   **Chosen sequence:** Vite SPA build (empties `dist/client`) → blog build with `outDir` = `../control-plane/dist/client` and `build.format` such that only blog routes are written (Astro should not delete unrelated SPA files when `outDir` already exists—verify; if Astro cleans outDir, use a copy step from `apps/blog/dist` into `dist/client` after SPA build).
4. Root `pnpm build` includes `@thwip/blog`.
5. `deploy:staging` unchanged in spirit: full monorepo build then wrangler; assets directory already points at `dist/client`.

**Verification:** after build, `dist/client/blog/index.html` and at least one post HTML exist; `curl -sI` on staging returns `text/html` for those paths, not SPA-only behavior for missing files.

## Integration with existing site chrome

- Add **Blog** link to `Chrome.tsx` `SiteBar` / `SiteFoot`.
- Astro layout duplicates bar/foot markup + shared CSS (no React island required for v1). Keep link lists in sync by convention; a later shared partial is optional YAGNI.
- Homepage may gain a single “Blog” or “Beta” teaser later; not required for blog v1 ship.

## Testing and quality bar

| Check | How |
|-------|-----|
| Frontmatter schema | Astro fails build on invalid posts |
| Draft exclusion | `draft: true` absent from index, RSS, sitemap in production mode |
| HTML smoke | Built files contain title, description meta, article body |
| RSS well-formed | Parse `rss.xml` after build |
| Link integrity | Internal links in first two posts resolve |
| Code copy | Manual or playwright smoke on one fence |
| Lighthouse / a11y | Reasonable contrast on prose; heading order |
| Knip / monorepo lint | Blog package wired so root lint does not break |

Automated tests can be minimal: a Node script or vitest that asserts built artifacts exist and contain expected strings for the two posts.

## Success criteria

- `/blog` and two posts live on `thwip.recall.net` with brand-consistent editorial UI.
- RSS + sitemap + updated `llms.txt` ship with the same deploy.
- Authors add a post by dropping a `.mdoc` file + assets; no code change unless new tags.
- No custom Markdown engine in repo beyond Markdoc config and Astro pages.
- Beta posts are substantive and installation path is copy-paste reliable.

## Open decisions resolved in brainstorming

| Decision | Choice |
|----------|--------|
| Purpose | Authority + growth |
| Look | Vercel/Railway structure; notary tokens (option A) |
| Authoring | Markdoc fixed tag map (option B family) |
| Stack | Astro + Markdoc + collections + RSS + sitemap + Shiki |
| Hosting | Same origin, static HTML into Worker assets |
| Subdomain | No |

## Follow-ups (not v1)

- Render FAQ/Install from the same content pipeline
- Content negotiation for `Accept: text/markdown` at the Worker (if CF zone feature insufficient)
- Shared HTML partial for bar/foot between SPA and Astro
- Authors collection, OG image generation, reading time
- Search Console generative AI report baseline after launch
