import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

import { authorFor, authorKeys, personKeys } from "./lib/authors";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.mdoc", base: "./src/content/blog" }),
  schema: z
    .object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      author: z.enum(authorKeys() as [string, ...string[]]),
      reviewedBy: z.enum(personKeys() as [string, ...string[]]).optional(),
      heroImage: z.string().optional(),
      heroAlt: z.string().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    })
    .superRefine((data, ctx) => {
      if (data.heroImage && !data.heroAlt) {
        ctx.addIssue({
          code: "custom",
          message: "heroAlt is required when heroImage is set",
          path: ["heroAlt"],
        });
      }
      // An agent byline is honest about who drafted the post, and it leaves
      // nobody accountable for it. A named human has to review the work.
      if (authorFor(data.author).kind === "agent" && !data.reviewedBy) {
        ctx.addIssue({
          code: "custom",
          message: `author "${data.author}" is an agent, so reviewedBy must name the person accountable for the post`,
          path: ["reviewedBy"],
        });
      }
    }),
});

export const collections = { blog };
