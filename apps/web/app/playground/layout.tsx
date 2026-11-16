import type { ReactNode } from "react";
import { PlaygroundSidebar, type SidebarGroup } from "@/components/playground/sidebar";
import { consoleServices } from "@/lib/playground/services";

const groups: SidebarGroup[] = [
  {
    title: "API consoles",
    links: consoleServices.map(({ name, label }) => ({ href: `/playground/${name}`, label })),
  },
];

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row">
      <PlaygroundSidebar groups={groups} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
