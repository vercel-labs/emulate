export const PAGE_TITLES: Record<string, string> = {
  "": "Local API Emulation\nfor CI and Sandboxes",
  configuration: "Configuration",
  vercel: "Vercel API",
  github: "GitHub API",
  google: "Google API",
  microsoft: "Microsoft API",
  authentication: "Authentication",
  architecture: "Architecture",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
