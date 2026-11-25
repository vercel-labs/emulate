export const PAGE_TITLES: Record<string, string> = {
  "": "API emulators for local dev, CI and sandboxes",
  "programmatic-api": "Programmatic API",
  "custom-emulators": "Custom Emulators",
  configuration: "Configuration",
  nextjs: "Next.js Integration",
  nuxt: "Nuxt Integration",
  vercel: "Vercel API",
  github: "GitHub API",
  google: "Google API",
  slack: "Slack API",
  linear: "Linear API",
  twilio: "Twilio API",
  apple: "Apple Sign In",
  microsoft: "Microsoft Entra ID",
  aws: "AWS",
  okta: "Okta",
  mongoatlas: "MongoDB Atlas",
  resend: "Resend",
  stripe: "Stripe",
  ai: "AI Responses",
  "expo-push": "Expo Push",
  authentication: "Authentication",
  architecture: "Architecture",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
