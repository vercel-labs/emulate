import { createSource } from "@vercel/geistdocs/source";
import { docs } from "@/.source/server";
import { markdownForPathname } from "@/lib/page-markdown";
import { config } from "./config";

export const geistdocsSource = createSource({
  docs,
  config,
  baseUrl: "/docs",
  markdown: {
    transform: async (_markdown, { page }) =>
      (await markdownForPathname(`/docs${page.slugs.length ? `/${page.slugs.join("/")}` : ""}`)).body,
  },
});
