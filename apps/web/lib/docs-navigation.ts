export type NavItem = {
  name: string;
  href: string;
};

export const allDocsPages: NavItem[] = [
  { name: "Getting Started", href: "/docs" },
  { name: "Programmatic API", href: "/docs/programmatic-api" },
  { name: "Configuration", href: "/docs/configuration" },
  { name: "Next.js Integration", href: "/docs/nextjs" },
  { name: "Vercel API", href: "/docs/vercel" },
  { name: "GitHub API", href: "/docs/github" },
  { name: "Google API", href: "/docs/google" },
  { name: "Slack API", href: "/docs/slack" },
  { name: "Discord API", href: "/docs/discord" },
  { name: "Apple Sign In", href: "/docs/apple" },
  { name: "Microsoft Entra ID", href: "/docs/microsoft" },
  { name: "AWS", href: "/docs/aws" },
  { name: "Okta", href: "/docs/okta" },
  { name: "MongoDB Atlas", href: "/docs/mongoatlas" },
  { name: "Resend", href: "/docs/resend" },
  { name: "Stripe", href: "/docs/stripe" },
  { name: "Authentication", href: "/docs/authentication" },
  { name: "Architecture", href: "/docs/architecture" },
];
