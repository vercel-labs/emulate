import { generateNotFoundMarkdown } from "@vercel/agent-readability";
import { loadAllDocsSources, loadDocsSource, normalizeDocsHref } from "./docs-source";
import { canonicalUrlFor, siteName, siteUrl } from "./site";

function frontmatter(fields: { title: string; description: string; canonicalUrl: string }): string {
  return [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    `description: ${JSON.stringify(fields.description)}`,
    `canonical_url: ${JSON.stringify(fields.canonicalUrl)}`,
    "---",
    "",
  ].join("\n");
}

export async function sitemapMarkdown(): Promise<string> {
  const sources = await loadAllDocsSources();
  return [
    `# ${siteName} documentation`,
    "",
    ...sources.map((source) => `- [${source.title}](${source.canonicalUrl})`),
    "",
  ].join("\n");
}

export function notFoundMarkdown(pathname: string): string {
  return generateNotFoundMarkdown(pathname, {
    sitemapUrl: "/sitemap.md",
    indexUrl: "/llms.txt",
    exampleUrl: "/docs/github",
    baseUrl: siteUrl,
  });
}

export async function markdownForPathname(pathname: string): Promise<{
  body: string;
  canonicalUrl: string;
  found: boolean;
}> {
  const normalized = normalizeDocsHref(pathname);
  const source = await loadDocsSource(normalized);
  if (source) {
    return {
      body: `${frontmatter(source)}${source.markdown}\n`,
      canonicalUrl: source.canonicalUrl,
      found: true,
    };
  }

  return { body: notFoundMarkdown(normalized), canonicalUrl: canonicalUrlFor(normalized), found: false };
}
