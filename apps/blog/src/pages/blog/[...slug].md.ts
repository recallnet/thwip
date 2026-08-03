import type { APIRoute } from "astro";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishedPosts } from "../../lib/posts";

/** Package root while Astro builds; endpoints run from dist, so do not use import.meta.url for content. */
const contentDir = join(process.cwd(), "src/content/blog");

export async function getStaticPaths() {
  const posts = await publishedPosts();
  return posts.map((post) => ({
    params: { slug: post.id },
  }));
}

export const GET: APIRoute = async ({ params }) => {
  const id = params.slug;
  if (!id || id.includes("..") || id.includes("/")) {
    return new Response("Not found", { status: 404 });
  }
  const body = await readFile(join(contentDir, `${id}.mdoc`), "utf8");
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
