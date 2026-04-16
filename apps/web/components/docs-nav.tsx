"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavSection = {
  title?: string;
  items: { href: string; label: string }[];
};

const sections: NavSection[] = [
  {
    items: [
      { href: "/", label: "Getting Started" },
      { href: "/programmatic-api", label: "Programmatic API" },
      { href: "/configuration", label: "Configuration" },
      { href: "/nextjs", label: "Next.js Integration" },
    ],
  },
  {
    title: "Services",
    items: [
      { href: "/vercel", label: "Vercel" },
      { href: "/github", label: "GitHub" },
      { href: "/google", label: "Google" },
      { href: "/slack", label: "Slack" },
      { href: "/apple", label: "Apple" },
      { href: "/microsoft", label: "Microsoft Entra ID" },
      { href: "/aws", label: "AWS" },
      { href: "/okta", label: "Okta" },
      { href: "/mongoatlas", label: "MongoDB Atlas" },
      { href: "/resend", label: "Resend" },
      { href: "/stripe", label: "Stripe" },
    ],
  },
  {
    title: "Reference",
    items: [
      { href: "/authentication", label: "Authentication" },
      { href: "/architecture", label: "Architecture" },
    ],
  },
];

function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <nav className="sticky top-20 space-y-6">
        {sections.map((section, i) => (
          <div key={i}>
            {section.title && (
              <div className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-600">
                {section.title}
              </div>
            )}
            <div className="space-y-1">
              {section.items.map(({ href, label }) => {
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                        : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                    }`}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function DocsNav({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8 lg:py-12">
      <div className="flex gap-12">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <article className="max-w-none">{children}</article>
        </main>
      </div>
    </div>
  );
}
