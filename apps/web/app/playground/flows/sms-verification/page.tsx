import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SmsVerificationFlow } from "@/components/playground/flows/sms-verification";
import { mutedClass } from "@/components/playground/ui";
import { flows } from "@/lib/playground/flows";

const flow = flows.find((item) => item.slug === "sms-verification");

export const metadata: Metadata = {
  title: "Twilio SMS verification",
  description: flow?.description,
};

export default function SmsVerificationPage() {
  if (!flow) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
          {flow.label}
        </h1>
        <p className="max-w-2xl text-base text-neutral-600 dark:text-neutral-400">{flow.description}</p>
        <p className={mutedClass}>
          Runs in your browser. A service worker answers every request, so nothing reaches a server.{" "}
          <Link
            href="/playground/twilio"
            className="font-medium text-neutral-900 underline underline-offset-4 dark:text-neutral-100"
          >
            Open the Twilio console
          </Link>
        </p>
      </header>
      <SmsVerificationFlow />
    </div>
  );
}
