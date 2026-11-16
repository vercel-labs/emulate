"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export interface NavGroup {
  title: string;
  links: { href: string; label: string }[];
}

/** Switcher listing every playground, with the current one marked. */
export function PlaygroundNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Playgrounds"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-3 md:sticky md:top-0 md:h-screen md:w-60 md:flex-col md:items-stretch md:overflow-y-auto md:border-r md:border-b-0"
    >
      <div className="flex items-center justify-between gap-2">
        <Link href="/" className="px-2 py-1.5 text-sm font-semibold whitespace-nowrap">
          emulate playground
        </Link>
        <ThemeToggle />
      </div>
      {groups.map((group) => (
        <div key={group.title} className="flex items-center gap-1 md:mt-3 md:flex-col md:items-stretch">
          <p className="px-2 text-xs font-medium whitespace-nowrap text-muted-foreground">{group.title}</p>
          {group.links.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
                  active && "bg-muted font-medium text-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
