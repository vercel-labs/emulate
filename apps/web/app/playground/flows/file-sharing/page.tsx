import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileSharing } from "@/components/playground/flows/file-sharing";
import { mutedClass } from "@/components/playground/ui";
import { flows } from "@/lib/playground/flows";

const flow = flows.find((item) => item.slug === "file-sharing");

export const metadata: Metadata = {
  title: "Vercel Blob sharing",
  description: flow?.description,
};

export default function FileSharingPage() {
  if (!flow) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{flow.label}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{flow.description}</p>
        <p className={mutedClass}>
          Runs in your browser. A service worker answers every request, so nothing reaches a server.{" "}
          <Link
            href="/playground/vercel"
            className="underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Open the Vercel console
          </Link>
        </p>
      </header>
      <FileSharing />
    </div>
  );
}
