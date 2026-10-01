import { loadAllDocsSources } from "@/lib/docs-source";
import { siteDescription, siteName, siteUrl } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const sources = await loadAllDocsSources();
  const body = [
    `# ${siteName}`,
    "",
    `> ${siteDescription}`,
    "",
    `Documentation: [${siteUrl}/docs](${siteUrl}/docs)`,
    "",
    "## Pages",
    "",
    ...sources.map((source) => `- [${source.title}](${siteUrl}${source.markdownHref})`),
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
