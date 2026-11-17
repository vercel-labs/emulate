import { createGeistdocs } from "@vercel/geistdocs/next";

const withMDX = createGeistdocs();

const browserShims = {
  buffer: "buffer",
  "next/dist/compiled/buffer": "buffer",
  crypto: "crypto",
  "dns/promises": "dns-promises",
  fs: "fs",
  "fs/promises": "fs-promises",
  http: "http",
  https: "https",
  net: "net",
  path: "path",
  stream: "stream",
  url: "url",
};
const resolveAlias = Object.fromEntries(
  Object.entries(browserShims).flatMap(([name, file]) => {
    const target = { browser: `./lib/emulator-browser/${file}.ts` };
    return [
      [name, target],
      [`node:${name}`, target],
    ];
  }),
);
const processPolyfill = { browser: "next/dist/compiled/process" };
Object.assign(resolveAlias, { process: processPolyfill, "node:process": processPolyfill });
const playgroundBuild = process.env.VERCEL_GIT_COMMIT_SHA ?? Date.now().toString(36);

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
  turbopack: { resolveAlias },
  env: { NEXT_PUBLIC_PLAYGROUND_BUILD: playgroundBuild },
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
