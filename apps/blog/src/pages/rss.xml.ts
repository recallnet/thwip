import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { authorFor } from "../lib/authors";
import { publishedPosts } from "../lib/posts";

export async function GET(context: APIContext) {
  const posts = await publishedPosts();
  return rss({
    title: "thwip blog",
    description: "Commit-carried CI evidence for agent-run pipelines.",
    site: context.site ?? "https://thwip.ai",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.id}/`,
      customData: `<dc:creator>${authorFor(post.data.author).displayName}</dc:creator>`,
    })),
    xmlns: { dc: "http://purl.org/dc/elements/1.1/" },
  });
}
