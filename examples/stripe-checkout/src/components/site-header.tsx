import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#changelog", label: "Changelog" },
  { href: "/dashboard", label: "Licenses" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-foreground/8 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="transition-colors hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className={cn(buttonVariants({ variant: "ghost" }), "hidden sm:inline-flex")}>
            Sign in
          </Link>
          <Link href="/#pricing" className={cn(buttonVariants({ variant: "default" }))}>
            Get Acme Studio
          </Link>
        </div>
      </div>
    </header>
  );
}
