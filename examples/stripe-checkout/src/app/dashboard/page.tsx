import Link from "next/link";
import { Copy, KeyRound, Plus } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { listLicenses } from "@/lib/licenses";

// In-memory license store; never cache the rendered page.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const licenses = listLicenses();
  const totalCents = licenses.reduce((acc, l) => acc + l.amount, 0);

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:py-16">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Account</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Licenses</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Every Acme Studio license issued for this account.
              </p>
            </div>
            <Link href="/#pricing" className={cn(buttonVariants({ size: "lg" }))}>
              <Plus className="size-4" />
              Buy another
            </Link>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/8">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Active licenses</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{licenses.length}</p>
            </div>
            <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/8">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Total spend</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                ${(totalCents / 100).toFixed(2)}
              </p>
            </div>
            <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/8">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Plan</p>
              <p className="mt-2 inline-flex items-center gap-2 text-base font-medium">
                <span className="size-1.5 rounded-full bg-foreground" />
                Lifetime
              </p>
            </div>
          </div>

          <div className="mt-10 overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/8">
            <div className="flex items-center justify-between border-b border-foreground/8 px-6 py-4">
              <p className="text-sm font-semibold tracking-tight">License keys</p>
              <p className="text-xs text-muted-foreground">
                {licenses.length} {licenses.length === 1 ? "key" : "keys"}
              </p>
            </div>

            {licenses.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                  <KeyRound className="size-5" />
                </div>
                <p className="text-sm font-medium">No licenses yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Purchase Acme Studio to get a license key. The receipt and key will appear here.
                </p>
                <Link href="/#pricing" className={cn(buttonVariants({ size: "default" }), "mt-2")}>
                  Buy lifetime — $29
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-foreground/8">
                {licenses.map((license) => (
                  <li
                    key={license.key}
                    className="flex flex-wrap items-center gap-4 px-6 py-4 transition-colors hover:bg-muted/40"
                  >
                    <div className="grid size-9 place-items-center rounded-md bg-foreground/5 text-foreground">
                      <KeyRound className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px]">{license.key}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {license.product} ·{" "}
                        <span className="tabular-nums">
                          ${(license.amount / 100).toFixed(2)} {license.currency.toUpperCase()}
                        </span>{" "}
                        · {new Date(license.issuedAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-medium">
                      <span className="size-1.5 rounded-full bg-foreground" />
                      Active
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10"
                    >
                      <Copy className="size-3.5" />
                      Copy
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
