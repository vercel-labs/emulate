"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SidebarGroup {
  title: string;
  links: { href: string; label: string }[];
}

const linkClass =
  "rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 aria-[current=page]:bg-neutral-100 aria-[current=page]:font-medium aria-[current=page]:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 dark:aria-[current=page]:bg-neutral-900 dark:aria-[current=page]:text-neutral-100";

/** Switcher listing every playground, with the current one marked. */
export function PlaygroundSidebar({ groups }: { groups: SidebarGroup[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Playgrounds"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-200 p-3 md:sticky md:top-16 md:h-[calc(100vh-4rem)] md:w-56 md:flex-col md:items-stretch md:overflow-y-auto md:border-r md:border-b-0 dark:border-neutral-800"
    >
      <Link href="/playground" aria-current={pathname === "/playground" ? "page" : undefined} className={linkClass}>
        Overview
      </Link>
      {groups.map((group) => (
        <div key={group.title} className="flex items-center gap-1 md:mt-3 md:flex-col md:items-stretch">
          <p className="px-2 text-xs font-medium whitespace-nowrap text-neutral-500 dark:text-neutral-400">
            {group.title}
          </p>
          {group.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
              className={linkClass}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
