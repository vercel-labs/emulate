import type { Metadata } from "next";
import Link from "next/link";
import { consoleServices } from "@/lib/playground/services";

export const metadata: Metadata = {
  title: "Playground",
  description: "Try each emulator in your browser tab. Nothing is sent to a server, and a reload starts fresh.",
};

export default function PlaygroundPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
      <h1 className="mb-4 text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
        Playground
      </h1>
      <p className="mb-10 max-w-2xl text-base text-neutral-600 dark:text-neutral-400">
        Each emulator runs inside your browser tab. Nothing is sent to a server, and every visitor gets a private copy.
        Reload the page to start fresh.
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {consoleServices.map((service) => {
          const requests = service.groups.reduce((total, group) => total + group.presets.length, 0);
          return (
            <li key={service.name}>
              <Link
                href={`/playground/${service.name}`}
                className="flex h-full flex-col gap-2 rounded-lg border border-neutral-200 p-4 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{service.label}</span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{requests} requests</span>
                </span>
                <span className="text-sm text-neutral-600 dark:text-neutral-400">{service.description}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
