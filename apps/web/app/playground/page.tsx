import type { Metadata } from "next";
import Link from "next/link";
import { flows } from "@/lib/playground/flows";
import { consoleServices } from "@/lib/playground/services";

export const metadata: Metadata = {
  title: "Playground",
  description: "Try each emulator in your browser tab. Nothing is sent to a server, and a reload starts fresh.",
};

const sections = [
  {
    title: "Flows",
    intro: "Guided demos that drive an emulator through a real app feature.",
    items: flows.map((flow) => ({
      href: `/playground/flows/${flow.slug}`,
      label: flow.label,
      description: flow.description,
      meta: flow.services.join(", "),
    })),
  },
  {
    title: "API consoles",
    intro: "Every operation an emulator supports, ready to send with its method, path, headers, and body filled in.",
    items: consoleServices.map((service) => ({
      href: `/playground/${service.name}`,
      label: service.label,
      description: service.description,
      meta: `${service.groups.reduce((total, group) => total + group.presets.length, 0)} requests`,
    })),
  },
];

export default function PlaygroundPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-6 py-16 sm:py-20">
      <header>
        <h1 className="mb-4 text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
          Playground
        </h1>
        <p className="max-w-2xl text-base text-neutral-600 dark:text-neutral-400">
          Each emulator runs inside your browser tab. Nothing is sent to a server, and every visitor gets a private
          copy. Reload the page to start fresh.
        </p>
      </header>
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{section.title}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{section.intro}</p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex h-full flex-col gap-2 rounded-lg border border-neutral-200 p-4 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
                >
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{item.label}</span>
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">{item.description}</span>
                  <span className="mt-auto text-xs text-neutral-500 dark:text-neutral-400">{item.meta}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
