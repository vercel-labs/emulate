import { createGeistdocs } from "@vercel/geistdocs/next";

const withMDX = createGeistdocs();

const oldDocsSlugs = [
  "programmatic-api",
  "configuration",
  "nextjs",
  "vercel",
  "github",
  "google",
  "slack",
  "linear",
  "apple",
  "microsoft",
  "aws",
  "okta",
  "mongoatlas",
  "resend",
  "stripe",
  "authentication",
  "architecture",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  skipProxyUrlNormalize: true,
  serverExternalPackages: ["just-bash", "bash-tool"],
  outputFileTracingIncludes: {
    "/*": ["./content/docs/**/*.mdx"],
  },
  async headers() {
    return process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production"
      ? [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }]
      : [];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/docs.md", destination: "/api/docs-md" },
        { source: "/docs/index.md", destination: "/api/docs-md" },
        { source: "/docs/:path*.md", destination: "/api/docs-md/:path*" },
      ],
    };
  },
  async redirects() {
    return oldDocsSlugs.map((slug) => ({
      source: `/${slug}`,
      destination: `/docs/${slug}`,
      permanent: true,
    }));
  },
};

export default withMDX(nextConfig);
