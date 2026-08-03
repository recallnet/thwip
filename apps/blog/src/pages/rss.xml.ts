import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { publishedPosts } from "../lib/posts";

export async function GET(context: APIContext) {
  const posts = await publishedPosts();
  return rss({
    title: "thwip blog",
    description: "Commit-carried CI evidence for agent-run pipelines.",
    site: context.site ?? "https://thwip.recall.net",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.id}/`,
    })),
  });
}
