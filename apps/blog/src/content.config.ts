import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.mdoc", base: "./src/content/blog" }),
  schema: z
    .object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      author: z.string(),
      heroImage: z.string().optional(),
      heroAlt: z.string().optional(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    })
    .superRefine((data, ctx) => {
      if (data.heroImage && !data.heroAlt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "heroAlt is required when heroImage is set",
          path: ["heroAlt"],
        });
      }
    }),
});

export const collections = { blog };
