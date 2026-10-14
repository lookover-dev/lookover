// The docs collection, on Starlight's loader and schema. JavaScript, not TypeScript: `astro:content` is one of
// Astro's virtual modules, which the root typecheck can't see (ADR 0064, 2).

import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
