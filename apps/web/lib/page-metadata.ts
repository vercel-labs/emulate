import type { Metadata } from "next";
import { PAGE_TITLES } from "./page-titles";
import { canonicalUrlFor, isPreview, siteDescription } from "./site";

export function pageMetadata(slug: string): Metadata {
  const pathname = slug ? `/docs/${slug}` : "/docs";
  const indexing: Metadata = {
    robots: { index: !isPreview, follow: !isPreview },
    alternates: { canonical: pathname, types: { "text/markdown": `${pathname}.md` } },
  };
  // The docs index keeps the site-wide title and social card from the root layout.
  const title = slug ? PAGE_TITLES[slug] : undefined;
  if (!title) return indexing;

  const displayTitle = title.replace(/\n/g, " ");
  const fullTitle = `${displayTitle} | emulate`;
  const ogImageUrl = slug ? `/og/${slug}` : "/og";

  return {
    ...indexing,
    title: displayTitle,
    description: siteDescription,
    openGraph: {
      url: canonicalUrlFor(pathname),
      type: "website",
      locale: "en_US",
      siteName: "emulate",
      title: fullTitle,
      description: siteDescription,
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${displayTitle} - emulate`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: siteDescription,
      images: [ogImageUrl],
    },
  };
}
