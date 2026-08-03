# Product Blog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a static Astro + Markdoc product blog at `thwip.recall.net/blog` with brand tokens, RSS/sitemap/llms integration, and two beta posts, without building a custom content engine.

**Architecture:** New `apps/blog` (`@thwip/blog`) builds static HTML. After the Vite SPA empties `apps/control-plane/dist/client`, a copy step merges blog output into that directory so the existing Worker assets binding serves `/blog/**`, `/rss.xml`, and sitemaps. Markdoc tags map to a fixed set of Astro components. SPA chrome gains a Blog link.

**Tech Stack:** Astro (static), `@astrojs/markdoc` + Shiki, Content Collections + Zod, `@astrojs/rss`, `@astrojs/sitemap`, existing notary CSS tokens, pnpm workspace, Cloudflare Workers assets (unchanged host).

**Spec:** `docs/superpowers/specs/2026-08-03-product-blog-design.md`

---

## File map

| Path | Responsibility |
|------|----------------|
| `apps/blog/package.json` | Package scripts and dependencies |
| `apps/blog/astro.config.mjs` | site URL, integrations, static outDir |
| `apps/blog/markdoc.config.mjs` | Tags + Shiki |
| `apps/blog/tsconfig.json` | Astro TS |
| `apps/blog/src/content.config.ts` | `blog` collection schema |
| `apps/blog/src/content/blog/*.mdoc` | Posts |
| `apps/blog/src/components/*` | Layout pieces + Markdoc tags |
| `apps/blog/src/layouts/BlogLayout.astro` | Document shell, meta, JSON-LD |
| `apps/blog/src/pages/blog/index.astro` | Index |
| `apps/blog/src/pages/blog/[...slug].astro` | Post pages |
| `apps/blog/src/pages/blog/[...slug].md.ts` | Markdown twins |
| `apps/blog/src/pages/rss.xml.ts` | RSS |
| `apps/blog/src/styles/tokens.css` | Shared design tokens |
| `apps/blog/src/styles/editorial.css` | Prose / index / code chrome |
| `apps/blog/public/blog/*` | Product shot assets |
| `apps/blog/scripts/merge-into-client.mjs` | Copy build → control-plane dist |
| `apps/blog/scripts/assert-build.mjs` | Post-build smoke checks |
| `apps/control-plane/web/src/Chrome.tsx` | Blog nav link |
| `apps/control-plane/web/public/llms.txt` | Blog section (or generated overwrite from blog build) |
| `package.json` (root) | Ensure recursive build includes blog |

---

### Task 1: Scaffold `@thwip/blog` package

**Files:**
- Create: `apps/blog/package.json`
- Create: `apps/blog/tsconfig.json`
- Create: `apps/blog/astro.config.mjs`
- Create: `apps/blog/.gitignore` (optional: `dist/`, `.astro/`)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@thwip/blog",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build && node scripts/merge-into-client.mjs && node scripts/assert-build.mjs",
    "typecheck": "astro check",
    "preview": "astro preview"
  },
  "dependencies": {
    "@astrojs/markdoc": "^0.15.0",
    "@astrojs/rss": "^4.0.0",
    "@astrojs/sitemap": "^3.0.0",
    "astro": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

Pin versions to whatever `pnpm add` resolves in the monorepo at implement time (use current stable Astro 5.x and matching integrations).

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 3: Create astro.config.mjs**

```js
import { defineConfig } from "astro/config";
import markdoc from "@astrojs/markdoc";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://thwip.recall.net",
  integrations: [
    markdoc({ ignoreIndentation: true }),
    sitemap({
      filter: (page) => !page.includes("/blog/") || !page.endsWith(".md"),
    }),
  ],
  outDir: "dist",
  build: {
    format: "directory",
  },
});
```

Adjust sitemap filter if `.md` routes should stay out of the XML sitemap (recommended: HTML only).

- [ ] **Step 4: Install workspace deps**

Run from repo root:

```bash
pnpm install
```

Expected: `@thwip/blog` links; no sharp install required for v1.

- [ ] **Step 5: Commit**

```bash
git add apps/blog/package.json apps/blog/tsconfig.json apps/blog/astro.config.mjs pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(blog): scaffold Astro package for product blog

## Summary
Add apps/blog so product posts can ship as static assets.

## Changes
- @thwip/blog package with Astro, Markdoc, RSS, sitemap deps
EOF
)"
```

---

### Task 2: Content collection schema and Markdoc config

**Files:**
- Create: `apps/blog/src/content.config.ts`
- Create: `apps/blog/markdoc.config.mjs`
- Create: `apps/blog/src/content/blog/.gitkeep` (removed when first post lands)

- [ ] **Step 1: Content config**

```ts
// apps/blog/src/content.config.ts
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.mdoc", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string(),
    heroImage: z.string().optional(),
    heroAlt: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
```

If the installed Astro version still uses the legacy `src/content/config.ts` API, follow that version’s docs (same Zod fields).

- [ ] **Step 2: Markdoc config with Shiki**

```js
// apps/blog/markdoc.config.mjs
import { defineMarkdocConfig, component, nodes } from "@astrojs/markdoc/config";
import shiki from "@astrojs/markdoc/shiki";

export default defineMarkdocConfig({
  extends: [
    shiki({
      theme: "github-light",
      wrap: true,
    }),
  ],
  nodes: {
    document: {
      ...nodes.document,
      render: null,
    },
  },
  tags: {
    callout: {
      render: component("./src/components/Callout.astro"),
      attributes: {
        type: { type: String, default: "note", matches: ["note", "tip", "warning"] },
        title: { type: String, required: false },
      },
    },
    cta: {
      render: component("./src/components/Cta.astro"),
      attributes: {
        href: { type: String, required: true },
        label: { type: String, required: true },
        variant: { type: String, default: "primary", matches: ["primary", "ghost"] },
      },
      selfClosing: true,
    },
    "product-shot": {
      render: component("./src/components/ProductShot.astro"),
      attributes: {
        src: { type: String, required: true },
        alt: { type: String, required: true },
        caption: { type: String, required: false },
      },
      selfClosing: true,
    },
    steps: {
      render: component("./src/components/Steps.astro"),
    },
    step: {
      render: component("./src/components/Step.astro"),
      attributes: {
        title: { type: String, required: true },
      },
    },
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/blog/src/content.config.ts apps/blog/markdoc.config.mjs
git commit -m "feat(blog): content schema and Markdoc tag map"
```

---

### Task 3: Design tokens, editorial CSS, and UI components

**Files:**
- Create: `apps/blog/src/styles/tokens.css`
- Create: `apps/blog/src/styles/editorial.css`
- Create: `apps/blog/src/components/SiteBar.astro`
- Create: `apps/blog/src/components/SiteFoot.astro`
- Create: `apps/blog/src/components/Callout.astro`
- Create: `apps/blog/src/components/Cta.astro`
- Create: `apps/blog/src/components/ProductShot.astro`
- Create: `apps/blog/src/components/Steps.astro`
- Create: `apps/blog/src/components/Step.astro`
- Create: `apps/blog/src/components/CodeCopy.astro` (script island for copy buttons)
- Create: `apps/blog/src/layouts/BlogLayout.astro`

- [ ] **Step 1: Mirror tokens from control-plane `skin.css`**

Copy the CSS variables block from `apps/control-plane/web/src/skin.css` (`--paper`, `--ink`, `--muted`, `--civic`, `--mono`, `--sans`, `--num`, spacing scale) into `tokens.css`. Do not import Graphics Press into the blog; editorial CSS is standalone.

- [ ] **Step 2: Editorial layout CSS**

Implement in `editorial.css`:

- `.eb-bar` / `.eb-foot` matching public site link density
- `.eb-prose` max-width ~40rem, line-height ~1.6, heading scale
- Code blocks: border `--rule`, mono font, relative position for copy button
- `.eb-hero img` full-bleed within content width, caption under
- `.eb-card` list items on index
- `.eb-callout`, `.eb-cta`, `.eb-steps`

- [ ] **Step 3: SiteBar / SiteFoot**

Links: `/`, `/blog`, `/faq`, `/install`, `/dashboard`. Foot includes `/rss.xml` and `/llms.txt`.

- [ ] **Step 4: Tag components**

Minimal Astro components; slot children for callout/steps. `Cta` is an `<a class="eb-cta">`. `ProductShot` is `<figure><img loading="lazy">`.

- [ ] **Step 5: BlogLayout**

```astro
---
import "../styles/tokens.css";
import "../styles/editorial.css";
import SiteBar from "../components/SiteBar.astro";
import SiteFoot from "../components/SiteFoot.astro";
import CodeCopy from "../components/CodeCopy.astro";

interface Props {
  title: string;
  description: string;
  canonicalPath: string;
  ogImage?: string;
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
}
const { title, description, canonicalPath, ogImage, jsonLd } = Astro.props;
const canonical = new URL(canonicalPath, Astro.site).href;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="og:type" content="article" />
    {ogImage && <meta property="og:image" content={new URL(ogImage, Astro.site).href} />}
    <link rel="alternate" type="application/rss+xml" title="thwip blog" href="/rss.xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600&family=Archivo:wdth,wght@62..125,400..700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    {jsonLd && (
      <script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />
    )}
  </head>
  <body class="eb">
    <SiteBar />
    <slot />
    <SiteFoot />
    <CodeCopy />
  </body>
</html>
```

- [ ] **Step 6: CodeCopy script**

Vanilla JS: find `pre > code` (or Shiki wrappers), inject a button that copies text content. No React.

- [ ] **Step 7: Commit**

```bash
git add apps/blog/src
git commit -m "feat(blog): editorial layout and Markdoc components"
```

---

### Task 4: Routes — index, post, RSS, markdown twins

**Files:**
- Create: `apps/blog/src/pages/blog/index.astro`
- Create: `apps/blog/src/pages/blog/[...slug].astro`
- Create: `apps/blog/src/pages/blog/[...slug].md.ts`
- Create: `apps/blog/src/pages/rss.xml.ts`
- Create: `apps/blog/src/lib/posts.ts` (filter published)

- [ ] **Step 1: posts helper**

```ts
// apps/blog/src/lib/posts.ts
import { getCollection, type CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;

export async function publishedPosts(): Promise<BlogPost[]> {
  const all = await getCollection("blog");
  return all
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
```

- [ ] **Step 2: Index page**

List published posts with title, date, description, link to `/blog/${id}/` (directory format).

- [ ] **Step 3: Post page**

```astro
---
import { getCollection, render } from "astro:content";
import BlogLayout from "../../layouts/BlogLayout.astro";
import { publishedPosts } from "../../lib/posts";

export async function getStaticPaths() {
  const posts = await publishedPosts();
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}

const { post } = Astro.props;
const { Content } = await render(post);
const path = `/blog/${post.id}/`;
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: post.data.title,
  description: post.data.description,
  datePublished: post.data.pubDate.toISOString(),
  dateModified: (post.data.updatedDate ?? post.data.pubDate).toISOString(),
  author: { "@type": "Person", name: post.data.author },
  mainEntityOfPage: { "@type": "WebPage", "@id": new URL(path, Astro.site).href },
};
---
<BlogLayout
  title={`${post.data.title} · thwip`}
  description={post.data.description}
  canonicalPath={path}
  ogImage={post.data.heroImage}
  jsonLd={jsonLd}
>
  <article class="eb-article">
    <header class="eb-article__header">
      <p class="eb-meta">
        <time datetime={post.data.pubDate.toISOString()}>
          {post.data.pubDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
        </time>
        · {post.data.author}
      </p>
      <h1>{post.data.title}</h1>
      <p class="eb-lede">{post.data.description}</p>
    </header>
    {post.data.heroImage && (
      <figure class="eb-hero">
        <img src={post.data.heroImage} alt={post.data.heroAlt ?? ""} />
      </figure>
    )}
    <div class="eb-prose">
      <Content />
    </div>
    <p class="eb-md-alt">
      <a href={`/blog/${post.id}.md`}>Markdown source</a>
    </p>
  </article>
</BlogLayout>
```

- [ ] **Step 4: Markdown twin endpoint**

Return `text/markdown` body: optional YAML frontmatter + raw file text (read from collection or `import.meta.glob` raw). Set `Content-Type: text/markdown; charset=utf-8`.

Implement as `src/pages/blog/[...slug].md.ts` using Astro endpoints:

```ts
import type { APIRoute } from "astro";
import { publishedPosts } from "../../lib/posts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function getStaticPaths() {
  const posts = await publishedPosts();
  return posts.map((post) => ({ params: { slug: post.id } }));
}

export const GET: APIRoute = async ({ params }) => {
  // Resolve path to the .mdoc source and return its contents (or a stripped body).
  // Prefer shipping the authoring source so agents see the same text as the site.
  const id = params.slug;
  const url = new URL(`../../content/blog/${id}.mdoc`, import.meta.url);
  const body = await readFile(fileURLToPath(url), "utf8");
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
```

If static path naming for `.md` is awkward with Astro, use `src/pages/blog/[slug].md.ts` with `params.slug` only (no nested slashes in v1 ids).

- [ ] **Step 5: RSS**

```ts
// apps/blog/src/pages/rss.xml.ts
import rss from "@astrojs/rss";
import { publishedPosts } from "../lib/posts";

export async function GET(context: { site?: URL }) {
  const posts = await publishedPosts();
  return rss({
    title: "thwip blog",
    description: "Commit-carried CI evidence for agent-run pipelines.",
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.id}/`,
    })),
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/blog/src
git commit -m "feat(blog): index, post, RSS, and markdown twin routes"
```

---

### Task 5: Merge script, build smoke, monorepo wiring

**Files:**
- Create: `apps/blog/scripts/merge-into-client.mjs`
- Create: `apps/blog/scripts/assert-build.mjs`
- Modify: `apps/control-plane/package.json` (order of build if needed)
- Modify: root build already uses `pnpm -r ... apps/**` — confirm filter includes blog

- [ ] **Step 1: merge-into-client.mjs**

```js
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "dist");
const client = join(root, "../control-plane/dist/client");

if (!existsSync(from)) {
  console.error("blog dist missing; run astro build first");
  process.exit(1);
}
if (!existsSync(client)) {
  console.error("control-plane dist/client missing; build SPA before blog merge");
  process.exit(1);
}

// Copy everything from Astro dist into client (blog/, rss.xml, sitemap*.xml, _astro assets)
cpSync(from, client, { recursive: true });
console.log("merged blog dist into control-plane/dist/client");
```

- [ ] **Step 2: assert-build.mjs**

Assert files exist:

- `../control-plane/dist/client/blog/index.html`
- at least one `blog/*/index.html` once posts exist
- `../control-plane/dist/client/rss.xml`
- HTML contains `<meta name="description"`

Exit 1 on failure.

- [ ] **Step 3: Build order**

Control-plane `build` currently:

```
generate-prompt-docs && tsc ... && vite build
```

Root: `pnpm -r --filter './packages/**' --filter './apps/**' run build`

pnpm recursive order is topological; `@thwip/blog` has no workspace dep on control-plane, so order is undefined. Fix by either:

**Option A (preferred):** control-plane build script ends with `pnpm --filter @thwip/blog run build`  
**Option B:** root `package.json` script `"build": "pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build && pnpm --filter @thwip/blog run build"`

Implement Option A so `deploy:staging` (which runs control-plane build path via workspace build) always merges blog after SPA.

Modify `apps/control-plane/package.json` `build`:

```json
"build": "node ../../scripts/generate-prompt-docs.mjs && tsc -p tsconfig.json --noEmit && tsc -p web/tsconfig.json && vite build --config web/vite.config.ts && pnpm --filter @thwip/blog run build"
```

If recursive build already built blog first (empty client), re-running blog after Vite is correct; assert-build enforces merge success.

- [ ] **Step 4: Dry-run build**

```bash
pnpm --filter @thwip/control-plane run build
```

Expected: SPA assets + blog merge (may fail assert until posts exist — add a stub post in Task 6 first if needed). Order: Task 6 posts before green assert, or temporarily allow zero posts in assert with a warning.

- [ ] **Step 5: Commit**

```bash
git add apps/blog/scripts apps/control-plane/package.json
git commit -m "build(blog): merge static blog into Worker client assets"
```

---

### Task 6: Two beta posts + assets

**Files:**
- Create: `apps/blog/src/content/blog/beta.mdoc`
- Create: `apps/blog/src/content/blog/beta-install.mdoc`
- Create: `apps/blog/public/blog/` product images (screenshots or designed heroes)
- Update: `apps/control-plane/web/public/llms.txt`

- [ ] **Step 1: Write `beta.mdoc`**

Frontmatter + body covering: beta announcement, what thwip is, profiles (fast/remote), what is and is not claimed, CTA to install post and dashboard. Use `{% callout %}`, `{% cta %}`, `{% product-shot %}` as appropriate. Non-commodity, precise language matching FAQ tone.

- [ ] **Step 2: Write `beta-install.mdoc`**

Step-by-step: install CLI, login, device key, init, run. Fenced bash blocks. `{% steps %}` / `{% step %}`. Link to `/install` agent prompt and `/dashboard`.

- [ ] **Step 3: Add hero/product images** under `public/blog/` with real alt text. Prefer captures of the real product UI; if placeholders, mark and replace before public launch.

- [ ] **Step 4: Extend llms.txt**

Add section:

```markdown
## Blog

- [Blog index](https://thwip.recall.net/blog/): product announcements and guides
- [Beta](https://thwip.recall.net/blog/beta.md): ...
- [Beta install](https://thwip.recall.net/blog/beta-install.md): ...
```

Also list HTML URLs. Keep under a size agents can load.

- [ ] **Step 5: Build and fix content/schema errors**

```bash
pnpm --filter @thwip/blog run build
```

- [ ] **Step 6: Commit**

```bash
git add apps/blog/src/content apps/blog/public apps/control-plane/web/public/llms.txt
git commit -m "content(blog): beta launch and install posts"
```

---

### Task 7: SPA chrome link + smoke tests

**Files:**
- Modify: `apps/control-plane/web/src/Chrome.tsx`
- Create: `apps/blog/scripts/assert-build.mjs` (finalize with post paths)
- Optional: `apps/blog/assert-build.test.mjs` run via node in build only (no vitest required)

- [ ] **Step 1: Add Blog to SiteBar and SiteFoot**

In `Chrome.tsx`, after Install (or before FAQ):

```tsx
<a href="/blog">Blog</a>
```

Same in foot.

- [ ] **Step 2: Full monorepo build**

```bash
pnpm build
```

Expected: success; `apps/control-plane/dist/client/blog/index.html` exists; posts present; `rss.xml` present.

- [ ] **Step 3: Manual preview**

```bash
pnpm --filter @thwip/control-plane exec wrangler dev --env staging
```

Open `/blog`, one post, `/rss.xml`, `/blog/beta.md`. Confirm SPA `/dashboard` still works and unknown paths still SPA-fallback.

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/web/src/Chrome.tsx apps/blog/scripts
git commit -m "feat(web): link Blog in site chrome"
```

---

### Task 8: Ops checklist (no code or light docs)

- [ ] **Step 1: Cloudflare AI crawl / managed robots**

In CF dashboard for the zone serving `thwip.recall.net`: ensure managed robots is not blanket-blocking retrieval bots you care about. Prefer allowing search/retrieval agents; training-only bots are a product choice. Document the chosen policy in `DEVIATIONS.md` or a short `docs/blog-ops.md` only if the team wants it recorded.

- [ ] **Step 2: Enable Markdown for Agents** (if plan/zone supports it)

Optional edge conversion on `Accept: text/markdown` for HTML pages.

- [ ] **Step 3: Search Console**

After deploy, verify property includes `/blog` URLs; later use Generative AI performance report (Google).

- [ ] **Step 4: Final commit if docs added**

```bash
git add docs/
git commit -m "docs: blog ops notes for crawler policy"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Astro + Markdoc + collections | 1–2 |
| Fixed tag map | 2–3 |
| Editorial layout + notary tokens | 3 |
| Index + post HTML | 4 |
| RSS + sitemap | 1, 4 |
| MD twins | 4 |
| Same-origin merge into Worker assets | 5 |
| Two beta posts | 6 |
| llms.txt | 6 |
| SPA Blog link | 7 |
| AI/crawl ops | 8 |
| No custom MD engine | all (library-only) |

## Placeholder scan

No TBD steps. Version pins may float at `pnpm add` time. Content copy is authored in Task 6, not pre-written here.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-product-blog.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with executing-plans and checkpoints  

Which approach?
