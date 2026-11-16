"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { flows } from "@/lib/playgrounds";
import { consoleServices } from "@/lib/services";
import { cn } from "@/lib/utils";

const groups = [
  { title: "Flows", links: flows.map(({ href, label }) => ({ href, label })) },
  { title: "API consoles", links: consoleServices.map(({ name, label }) => ({ href: `/services/${name}`, label })) },
];

/** Switcher listing every playground, with the current one marked. */
export function PlaygroundNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Playgrounds"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b p-3 md:sticky md:top-0 md:h-screen md:w-60 md:flex-col md:items-stretch md:overflow-y-auto md:border-r md:border-b-0"
    >
      <Link href="/" className="px-2 py-1.5 text-sm font-semibold whitespace-nowrap">
        emulate playground
      </Link>
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
