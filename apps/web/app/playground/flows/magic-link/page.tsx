import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MagicLinkFlow } from "@/components/playground/flows/magic-link";
import { flows } from "@/lib/playground/flows";

const flow = flows.find((item) => item.slug === "magic-link");

export const metadata: Metadata = {
  title: "Resend magic link",
  description: flow?.description,
};

export default function MagicLinkPage() {
  if (!flow) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{flow.label}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{flow.description}</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Runs in this tab. Nothing is sent to a server.{" "}
          <Link
            href="/playground/resend"
            className="underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Open the Resend console
          </Link>
        </p>
      </header>
      <MagicLinkFlow />
    </div>
  );
}
