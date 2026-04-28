import Link from "next/link";
import { Logo } from "@/components/logo";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/#features", label: "Features" },
      { href: "/#pricing", label: "Pricing" },
      { href: "/#changelog", label: "Changelog" },
      { href: "/dashboard", label: "Licenses" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "#", label: "Docs" },
      { href: "#", label: "Keybindings" },
      { href: "#", label: "Themes" },
      { href: "#", label: "Community" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "#", label: "About" },
      { href: "#", label: "Contact" },
      { href: "#", label: "Privacy" },
      { href: "#", label: "Terms" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-foreground/8 bg-muted/30">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-10 px-6 py-12 md:grid-cols-5">
        <div className="col-span-2 max-w-sm">
          <Logo />
          <p className="mt-3 text-sm text-muted-foreground">
            A fast, local-first markdown notebook for engineers. One payment, yours forever.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {col.title}
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {col.links.map((link) => (
                <li key={link.label}>
                  <Link href={link.href} className="text-foreground/80 transition-colors hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-foreground/8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-2 px-6 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} Acme Studio, Inc.</p>
          <p>
            Made with care. Demo backed by the local{" "}
            <Link
              href="https://github.com/vercel-labs/emulate"
              className="text-foreground/80 underline-offset-4 hover:underline"
            >
              emulate
            </Link>{" "}
            Stripe emulator — no real charge.
          </p>
        </div>
      </div>
    </footer>
  );
}
