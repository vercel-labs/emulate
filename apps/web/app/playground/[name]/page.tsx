import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmulatorConsole } from "@/components/playground/emulator-console";
import { consoleServices } from "@/lib/playground/services";

type Props = { params: Promise<{ name: string }> };

function findService(name: string) {
  const service = consoleServices.find((item) => item.name === name);
  if (!service) notFound();
  return service;
}

export function generateStaticParams() {
  return consoleServices.map((service) => ({ name: service.name }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const service = findService((await params).name);
  return { title: `${service.label} playground`, description: service.description };
}

export default async function EmulatorPlaygroundPage({ params }: Props) {
  const service = findService((await params).name);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{service.label}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{service.description}</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Runs in your browser. A service worker answers every request, so nothing reaches a server.
        </p>
      </header>
      <EmulatorConsole
        key={service.name}
        name={service.name}
        groups={service.groups}
        variables={service.variables ?? []}
      />
    </div>
  );
}
