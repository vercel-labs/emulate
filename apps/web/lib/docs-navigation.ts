export type NavItem = {
  name: string;
  href: string;
};

export const allDocsPages: NavItem[] = [
  { name: "Getting Started", href: "/" },
  { name: "Programmatic API", href: "/programmatic-api" },
  { name: "Configuration", href: "/configuration" },
  { name: "Next.js Integration", href: "/nextjs" },
  { name: "Vercel API", href: "/vercel" },
  { name: "GitHub API", href: "/github" },
  { name: "Google API", href: "/google" },
  { name: "Slack API", href: "/slack" },
  { name: "Apple Sign In", href: "/apple" },
  { name: "Microsoft Entra ID", href: "/microsoft" },
  { name: "AWS", href: "/aws" },
  { name: "Okta", href: "/okta" },
  { name: "MongoDB Atlas", href: "/mongoatlas" },
  { name: "Resend", href: "/resend" },
  { name: "Stripe", href: "/stripe" },
  { name: "Authentication", href: "/authentication" },
  { name: "Architecture", href: "/architecture" },
];
