import Link from "next/link";
import { ArrowRight, Check, Copy, Download } from "lucide-react";
import { Confetti } from "@/components/confetti";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { WebhookOverlay } from "@/components/webhook-overlay";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { findLicenseBySessionId, listLicenses } from "@/lib/licenses";

interface PageProps {
  searchParams: Promise<{ session_id?: string }>;
}

export default async function SuccessPage({ searchParams }: PageProps) {
  const { session_id } = await searchParams;

  // The emulator's WebhookDispatcher awaits webhook delivery before issuing
  // the redirect, so by the time the browser arrives here the license has
  // already been minted by the /webhooks/stripe handler.
  const license = session_id ? findLicenseBySessionId(session_id) : listLicenses()[0];

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <Confetti />
        <WebhookOverlay />

        <div className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
          <div className="flex flex-col items-center text-center">
            <div className="grid size-12 place-items-center rounded-full bg-foreground text-background">
              <Check className="size-6" strokeWidth={3} />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Payment received
            </p>
            <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Welcome to Acme Studio.
            </h1>
            <p className="mt-3 max-w-md text-balance text-sm text-muted-foreground">
              Your license is ready. Paste the key into the desktop app and Acme Studio is yours forever, on every
              machine you own.
            </p>
          </div>

          {license ? (
            <div className="mt-10 overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
              <div className="flex items-center justify-between gap-4 border-b border-foreground/8 px-6 py-4">
                <div>
                  <p className="text-sm font-semibold tracking-tight">Your license key</p>
                  <p className="text-xs text-muted-foreground">
                    Receipt #{license.key.slice(-8)} · {new Date(license.issuedAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10"
                >
                  <Copy className="size-3.5" />
                  Copy
                </button>
              </div>

              <div className="px-6 py-5">
                <p className="select-all break-all rounded-md bg-muted px-3 py-3 font-mono text-sm">
                  {license.key}
                </p>
              </div>

              <dl className="grid grid-cols-3 divide-x divide-foreground/8 border-t border-foreground/8 text-xs">
                <div className="px-6 py-4">
                  <dt className="text-muted-foreground">Product</dt>
                  <dd className="mt-1 font-medium">{license.product}</dd>
                </div>
                <div className="px-6 py-4">
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="mt-1 font-medium">
                    ${(license.amount / 100).toFixed(2)} {license.currency.toUpperCase()}
                  </dd>
                </div>
                <div className="px-6 py-4">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="mt-1 inline-flex items-center gap-1.5 font-medium">
                    <span className="size-1.5 rounded-full bg-foreground" />
                    Paid
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="mt-10 rounded-2xl bg-card p-6 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
              Webhook hasn&apos;t arrived yet. Refresh in a moment.
            </div>
          )}

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="#"
              className={cn(buttonVariants({ size: "lg" }), "min-w-[200px]")}
            >
              <Download className="size-4" />
              Download Acme Studio
            </Link>
            <Link
              href="/dashboard"
              className={cn(buttonVariants({ size: "lg", variant: "outline" }), "min-w-[200px]")}
            >
              View all licenses
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            A receipt was sent to your email (also emulated). Need help?{" "}
            <Link href="#" className="text-foreground underline-offset-4 hover:underline">
              Contact support
            </Link>
            .
          </p>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
