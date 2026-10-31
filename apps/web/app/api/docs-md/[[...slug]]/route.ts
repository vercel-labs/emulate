import { applyMarkdownHeaders } from "@vercel/agent-readability";
import { isSafePathSegments } from "@/lib/docs-source";
import { applyDocsResponseHeaders } from "@/lib/docs-response-headers";
import { markdownForPathname, notFoundMarkdown } from "@/lib/page-markdown";
import { canonicalUrlFor } from "@/lib/site";

type RouteContext = { params: Promise<{ slug?: string[] }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { slug = [] } = await params;
  const pathname = `/docs${slug.length ? `/${slug.join("/")}` : ""}`;
  const page = isSafePathSegments(slug)
    ? await markdownForPathname(pathname)
    : { body: notFoundMarkdown(pathname), canonicalUrl: canonicalUrlFor(pathname), found: false };
  const headers = new Headers({ "Content-Type": "text/markdown; charset=utf-8" });
  applyMarkdownHeaders(headers, { canonicalUrl: page.canonicalUrl });
  applyDocsResponseHeaders(headers);
  return new Response(page.body, { status: page.found ? 200 : 404, headers });
}
