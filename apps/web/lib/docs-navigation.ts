export type NavItem = {
  name: string;
  href: string;
  label?: string;
};

type NavSection = {
  title?: string;
  items: NavItem[];
};

export const docsSections: NavSection[] = [
  {
    items: [
      { name: "Getting Started", href: "/docs" },
      { name: "Custom Emulators", href: "/docs/custom-emulators" },
      { name: "Programmatic API", href: "/docs/programmatic-api" },
      { name: "Configuration", href: "/docs/configuration" },
      { name: "Next.js Integration", href: "/docs/nextjs" },
      { name: "Nuxt Integration", href: "/docs/nuxt" },
    ],
  },
  {
    title: "Services",
    items: [
      { name: "Vercel API", label: "Vercel", href: "/docs/vercel" },
      { name: "GitHub API", label: "GitHub", href: "/docs/github" },
      { name: "Google API", label: "Google", href: "/docs/google" },
      { name: "Slack API", label: "Slack", href: "/docs/slack" },
      { name: "Linear API", label: "Linear", href: "/docs/linear" },
      { name: "Twilio API", label: "Twilio", href: "/docs/twilio" },
      { name: "Apple Sign In", label: "Apple", href: "/docs/apple" },
      { name: "Microsoft Entra ID", href: "/docs/microsoft" },
      { name: "AWS", href: "/docs/aws" },
      { name: "Okta", href: "/docs/okta" },
      { name: "MongoDB Atlas", href: "/docs/mongoatlas" },
      { name: "Resend", href: "/docs/resend" },
      { name: "Stripe", href: "/docs/stripe" },
    ],
  },
  {
    title: "Reference",
    items: [
      { name: "Authentication", href: "/docs/authentication" },
      { name: "Architecture", href: "/docs/architecture" },
    ],
  },
];

export const allDocsPages: NavItem[] = docsSections.flatMap((section) => section.items);
