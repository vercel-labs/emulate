import { defineConfig } from "@vercel/geistdocs/config";
import { siteUrl } from "@/lib/site";

export const config = defineConfig({
  title: "emulate",
  siteUrl,
  defaultLanguage: "en",
  logo: <span className="font-[family-name:var(--font-geist-pixel-square)] text-lg">emulate</span>,
  navbarActiveProduct: "emulate",
  navbarBrand: "labs",
  github: {
    owner: "vercel-labs",
    repo: "emulate",
    branch: "main",
    editPath: "apps/web/content/docs",
  },
  content: [{ id: "docs", label: "Documentation", dir: "content/docs", route: "/docs" }],
  nav: [
    { label: "Docs", href: "/docs" },
    { label: "npm", href: "https://www.npmjs.com/package/emulate", external: true },
  ],
  ai: { enabled: false },
  feedback: { enabled: false },
  language: { enabled: false },
  pageActions: { askAI: false, openInChat: false },
  webmcp: { enabled: true },
});
