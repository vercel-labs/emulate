import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckoutFlow } from "@/components/playground/flows/checkout";
import { flows } from "@/lib/playground/flows";

const flow = flows.find((candidate) => candidate.slug === "checkout");

export const metadata: Metadata = {
  title: "Stripe checkout",
  description: flow?.description,
};

export default function CheckoutFlowPage() {
  if (!flow) notFound();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
          {flow.label}
        </h1>
        <p className="max-w-2xl text-base text-neutral-600 dark:text-neutral-400">{flow.description}</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Runs in your browser. A service worker answers every request, so nothing reaches a server.{" "}
          <Link
            href="/playground/stripe"
            className="underline underline-offset-4 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Open the Stripe console
          </Link>
        </p>
      </header>
      <CheckoutFlow />
    </div>
  );
}
