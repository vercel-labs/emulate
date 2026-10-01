import type { Metadata, Viewport } from "next";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";
import { cookies } from "next/headers";
import { DocsChat } from "@/components/docs-chat";
import { DocsProvider } from "@/components/geistdocs-provider";
import { config } from "@/lib/geistdocs/config";
import { isPreview, siteUrl } from "@/lib/site";
import "./globals.css";

const title = "emulate | Local API Emulation for CI & Sandboxes";
const description =
  "Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation. Not mocks.";

export const viewport: Viewport = { viewportFit: "cover" };

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s | emulate",
  },
  description,
  alternates: { canonical: "/" },
  robots: { index: !isPreview, follow: !isPreview },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "emulate",
    title,
    description,
    images: [{ url: "/og", width: 1200, height: 630, alt: "emulate" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og"],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const chatOpen = cookieStore.get("docs-chat-open")?.value === "true";
  const chatWidth = Math.min(700, Math.max(300, Number(cookieStore.get("docs-chat-width")?.value) || 400));
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "emulate",
    url: siteUrl,
    description,
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} antialiased`}
    >
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
        {chatOpen && (
          <style
            dangerouslySetInnerHTML={{
              __html: `@media(min-width:640px){body{padding-right:${chatWidth}px}}`,
            }}
          />
        )}
      </head>
      <body>
        <DocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
          <DocsChat defaultOpen={chatOpen} defaultWidth={chatWidth} />
        </DocsProvider>
      </body>
    </html>
  );
}
