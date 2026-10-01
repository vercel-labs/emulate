import { sitemapMarkdown } from "@/lib/page-markdown";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await sitemapMarkdown(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
