import { readFile } from "fs/promises";
import { join } from "path";
import { allDocsPages } from "./docs-navigation";
import { canonicalUrlFor, siteDescription } from "./site";

export type DocsSource = {
  title: string;
  href: string;
  markdownHref: string;
  canonicalUrl: string;
  description: string;
  markdown: string;
};

const sourcePromises = new Map<string, Promise<DocsSource>>();
const pagesByHref = new Map(allDocsPages.map((page) => [page.href, page]));

export function isSafePathSegments(segments: readonly string[]): boolean {
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\"),
  );
}

export function normalizeDocsHref(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function sourcePath(href: string): string {
  const slug = href === "/docs" ? "index" : href.slice("/docs/".length);
  return join(/* turbopackIgnore: true */ process.cwd(), "content", "docs", `${slug}.mdx`);
}

/** Reads a page's MDX source as Markdown. The docs use no JSX or ESM outside code blocks. */
export async function loadDocsSource(href: string): Promise<DocsSource | null> {
  const normalized = normalizeDocsHref(href);
  const page = pagesByHref.get(normalized);
  if (!page) return null;

  let pending = sourcePromises.get(normalized);
  if (!pending) {
    pending = readFile(sourcePath(normalized), "utf-8").then((raw) => {
      const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const title = frontmatter?.[1].match(/^title: (.+)$/m)?.[1];
      if (!frontmatter || !title) throw new Error(`Missing title for ${normalized}`);
      const heading = JSON.parse(title) as string;
      return {
        title: page.name,
        href: normalized,
        markdownHref: `${normalized}.md`,
        canonicalUrl: canonicalUrlFor(normalized),
        description: siteDescription,
        markdown: `# ${heading}\n\n${raw.slice(frontmatter[0].length).trim()}`,
      };
    });
    sourcePromises.set(normalized, pending);
    pending.catch(() => {
      if (sourcePromises.get(normalized) === pending) sourcePromises.delete(normalized);
    });
  }

  return pending;
}

export async function loadAllDocsSources(): Promise<DocsSource[]> {
  const sources = await Promise.all(allDocsPages.map((page) => loadDocsSource(page.href)));
  return sources.filter((source): source is DocsSource => source !== null);
}
