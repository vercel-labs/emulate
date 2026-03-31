export const PAGE_TITLES: Record<string, string> = {
  "": "Local API Emulation\nfor CI and Sandboxes",
  configuration: "Configuration",
  vercel: "Vercel API",
  github: "GitHub API",
  google: "Google API",
  slack: "Slack API",
  apple: "Apple Sign In",
  microsoft: "Microsoft Entra ID",
  aws: "AWS",
  authentication: "Authentication",
  architecture: "Architecture",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
