import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  Cpu,
  KeyRound,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { AppPreview } from "@/components/app-preview";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { createCheckoutSession } from "./checkout/actions";

const FEATURES = [
  {
    icon: Zap,
    title: "Instant on every keystroke",
    body: "Native Rust core. 60 fps editing in notebooks with tens of thousands of pages.",
  },
  {
    icon: Search,
    title: "Search that finds it",
    body: "Full-text and semantic search across every notebook, ranked by recency and your edit graph.",
  },
  {
    icon: Cpu,
    title: "Local-first, end-to-end",
    body: "Your notes live on your machine. Sync is opt-in and end-to-end encrypted.",
  },
  {
    icon: Sparkles,
    title: "Inline AI without lock-in",
    body: "Bring your own keys. Anthropic, OpenAI, Ollama, or anything OpenAI-compatible.",
  },
  {
    icon: Layers,
    title: "Notebooks, not folders",
    body: "Tagging, backlinks, and a daily journal that finds itself. No org-mode required.",
  },
  {
    icon: KeyRound,
    title: "One license, every device",
    body: "Activate on every machine you own. No seats, no MAU caps, no telemetry.",
  },
];

const PRICING_FEATURES = [
  "Unlimited notebooks and pages",
  "Mac, Windows, and Linux desktop apps",
  "All future updates, forever",
  "Self-hosted, no telemetry",
  "Activate on every machine you own",
  "Bring-your-own-keys AI",
];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="mx-auto w-full max-w-6xl px-6 pt-20 pb-12 sm:pt-28">
            <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
              <Link
                href="#changelog"
                className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-foreground"
              >
                <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background">
                  v2.4
                </span>
                Inline AI is shipped
                <ArrowRight className="size-3" />
              </Link>

              <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
                Notebooks at the speed of thought.
              </h1>
              <p className="mt-5 max-w-xl text-balance text-base text-muted-foreground sm:text-lg">
                Acme Studio is a local-first markdown notebook for engineers. Fast, keyboard-first, yours forever for one
                payment.
              </p>

              <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
                <Link href="#pricing" className={cn(buttonVariants({ size: "xl" }), "min-w-[180px]")}>
                  Buy lifetime — $29
                </Link>
                <Link
                  href="#features"
                  className={cn(buttonVariants({ size: "xl", variant: "outline" }), "min-w-[180px]")}
                >
                  See it in action
                </Link>
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                One payment. No subscription. 30-day refund, no questions.
              </p>
            </div>

            <div className="mt-16">
              <AppPreview />
            </div>
          </div>
        </section>

        <section className="border-t border-foreground/8 bg-muted/30">
          <div className="mx-auto w-full max-w-6xl px-6 py-10">
            <p className="text-center text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Used by engineers at
            </p>
            <div className="mt-6 grid grid-cols-2 gap-6 text-center text-sm font-semibold tracking-tight text-foreground/40 sm:grid-cols-4 lg:grid-cols-6">
              {["Northwind", "Soylent", "Initech", "Globex", "Hooli", "Pied Piper"].map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto w-full max-w-6xl px-6 py-24">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Why Acme</p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for engineers who think in markdown.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Every interaction is keyboard-first. Every byte stays on your machine. Every feature ships when it&apos;s
              ready, not when the quarter ends.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div
                  key={feature.title}
                  className="rounded-2xl bg-card p-6 ring-1 ring-foreground/8 transition-colors hover:ring-foreground/20"
                >
                  <div className="grid size-9 place-items-center rounded-md bg-foreground/5 text-foreground">
                    <Icon className="size-4" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold tracking-tight">{feature.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="pricing" className="border-y border-foreground/8 bg-muted/30">
          <div className="mx-auto w-full max-w-6xl px-6 py-24">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pricing</p>
              <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Pay once. Yours forever.
              </h2>
              <p className="mt-3 text-muted-foreground">
                No seats, no subscriptions, no telemetry. Activate on every machine you own.
              </p>
            </div>

            <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
              <div className="rounded-2xl bg-card p-8 ring-1 ring-foreground/10">
                <p className="text-sm font-semibold tracking-tight text-foreground">Free</p>
                <p className="mt-1 text-sm text-muted-foreground">For trying it out.</p>
                <div className="mt-6 flex items-baseline gap-1.5">
                  <span className="text-4xl font-semibold tracking-tight">$0</span>
                  <span className="text-sm text-muted-foreground">forever</span>
                </div>
                <ul className="mt-6 space-y-2 text-sm">
                  {[
                    "Up to 3 notebooks",
                    "Local-only, no sync",
                    "Community support",
                  ].map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="size-4 text-foreground/60" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="#"
                  className={cn(buttonVariants({ size: "lg", variant: "outline" }), "mt-8 w-full")}
                >
                  Download
                </Link>
              </div>

              <div className="relative rounded-2xl bg-foreground p-8 text-background ring-1 ring-foreground">
                <div className="absolute right-6 top-6 rounded-full bg-background/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                  Recommended
                </div>
                <p className="text-sm font-semibold tracking-tight">Lifetime</p>
                <p className="mt-1 text-sm text-background/70">For your forever notebook.</p>
                <div className="mt-6 flex items-baseline gap-1.5">
                  <span className="text-4xl font-semibold tracking-tight">$29</span>
                  <span className="text-sm text-background/70">one-time</span>
                </div>
                <ul className="mt-6 space-y-2 text-sm">
                  {PRICING_FEATURES.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="size-4 text-background/80" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <form action={createCheckoutSession} className="mt-8">
                  <button
                    type="submit"
                    className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-background text-base font-medium text-foreground transition-all hover:bg-background/90 active:translate-y-px"
                  >
                    Buy lifetime — $29
                  </button>
                </form>
                <p className="mt-3 text-center text-[11px] text-background/60">
                  Powered by an embedded Stripe emulator. No real charge.
                </p>
              </div>
            </div>

            <div className="mx-auto mt-10 max-w-3xl rounded-xl bg-card p-4 ring-1 ring-foreground/8">
              <div className="flex items-start gap-3 text-sm text-muted-foreground">
                <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-foreground/5 text-foreground">
                  <Bot className="size-4" />
                </div>
                <div>
                  <p className="font-medium text-foreground">This entire checkout runs locally.</p>
                  <p className="mt-1">
                    No Stripe account, no API keys, no webhook tunnel. The whole flow — pricing page, hosted Checkout,
                    webhook delivery, license fulfillment — happens inside this Next.js app, so your AI agent can run it
                    end-to-end in a sandbox.{" "}
                    <Link
                      href="https://github.com/vercel-labs/emulate/tree/main/examples/stripe-checkout"
                      className="text-foreground underline-offset-4 hover:underline"
                    >
                      See how it works
                    </Link>
                    .
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="changelog" className="mx-auto w-full max-w-6xl px-6 py-24">
          <div className="grid gap-10 md:grid-cols-[1fr_2fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Changelog</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">What shipped recently.</h2>
            </div>
            <ol className="relative space-y-8 border-l border-foreground/10 pl-6">
              {[
                {
                  v: "v2.4",
                  date: "Apr 2026",
                  title: "Inline AI",
                  body:
                    "Highlight, hit ⌘L, ask anything. Bring your own keys; we don't proxy. Streams locally with Ollama.",
                },
                {
                  v: "v2.3",
                  date: "Mar 2026",
                  title: "Daily journal that finds itself",
                  body:
                    "Pages with date stamps automatically thread into a journal view. Backlinks cross-link by day.",
                },
                {
                  v: "v2.2",
                  date: "Feb 2026",
                  title: "Native Linux build",
                  body:
                    "Same Rust core, same binary size (12 MB). Wayland-first, X11 supported.",
                },
              ].map((entry) => (
                <li key={entry.v} className="relative">
                  <span className="absolute -left-[31px] top-1.5 size-3 rounded-full bg-foreground" />
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-md bg-foreground/5 px-2 py-0.5 font-mono text-[11px] tracking-tight text-foreground/80">
                      {entry.v}
                    </span>
                    <span className="text-xs text-muted-foreground">{entry.date}</span>
                  </div>
                  <h3 className="mt-2 text-base font-semibold tracking-tight">{entry.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{entry.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-foreground/8 bg-foreground text-background">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-8 px-6 py-16 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Stop subscribing. Own your notebook.
              </h2>
              <p className="mt-3 text-background/70">
                $29 once. Activate on every machine. All future updates included.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="#pricing"
                className="inline-flex h-12 items-center gap-2 rounded-lg bg-background px-6 text-base font-medium text-foreground transition-all hover:bg-background/90 active:translate-y-px"
              >
                <ShieldCheck className="size-4" />
                Buy lifetime — $29
              </Link>
              <Link
                href="#features"
                className="inline-flex h-12 items-center rounded-lg border border-background/20 px-5 text-base font-medium text-background transition-colors hover:bg-background/10"
              >
                Tour the app
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
