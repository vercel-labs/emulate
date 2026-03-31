export type NavItem = {
  name: string;
  href: string;
};

export const allDocsPages: NavItem[] = [
  { name: "Getting Started", href: "/" },
  { name: "Configuration", href: "/configuration" },
  { name: "Vercel API", href: "/vercel" },
  { name: "GitHub API", href: "/github" },
  { name: "Google API", href: "/google" },
  { name: "Microsoft API", href: "/microsoft" },
  { name: "Authentication", href: "/authentication" },
  { name: "Architecture", href: "/architecture" },
];
