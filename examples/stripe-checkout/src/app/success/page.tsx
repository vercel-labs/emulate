export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getOrder } from "@/lib/orders";
import { formatCurrency } from "@/lib/products";
import { ClearCart } from "./clear-cart";

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-3 text-xs">
      <span className="tracking-[0.15em] uppercase text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-[11px]" : ""}>{value}</span>
    </div>
  );
}

export default async function SuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  if (!session_id) redirect("/");

  const session = await stripe.checkout.sessions.retrieve(session_id);
  const order = getOrder(session_id);

  let customer: { name: string | null; email: string | null } | null = null;
  if (session.customer && typeof session.customer === "string") {
    const c = await stripe.customers.retrieve(session.customer);
    if (!c.deleted) {
      customer = { name: c.name ?? null, email: c.email ?? null };
    }
  }

  return (
    <div className="mx-auto max-w-[480px] px-6 py-32">
      <ClearCart />
      <div className="text-center">
        <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground mb-4">Order Confirmed</p>
        <h1 className="font-pixel text-2xl">Thank You</h1>
        <p className="mt-4 text-sm text-muted-foreground">Your order has been placed successfully</p>
      </div>

      <div className="mt-12 divide-y divide-border border-y border-border">
        {customer?.name && <Row label="Customer" value={customer.name} />}
        {customer?.email && <Row label="Email" value={customer.email} />}
        <Row label="Session" value={session.id} mono />
        <Row label="Status" value={session.payment_status ?? "unknown"} />
        {order?.completedAt && <Row label="Confirmed" value={new Date(order.completedAt).toLocaleTimeString()} />}
        {order?.paymentIntentId && <Row label="Payment Intent" value={order.paymentIntentId} mono />}
        {order?.chargeId && <Row label="Charge" value={order.chargeId} mono />}
      </div>

      {session.amount_total != null && (
        <div className="flex items-center justify-between border-b border-border py-4">
          <span className="text-[10px] tracking-[0.3em] uppercase font-medium">Total</span>
          <span className="font-mono text-sm tabular-nums">
            {formatCurrency(session.amount_total, session.currency ?? "usd")}
          </span>
        </div>
      )}

      <div className="mt-10 text-center">
        <a
          href="/"
          className="inline-flex h-10 items-center border border-foreground px-8 text-[10px] tracking-[0.2em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background"
        >
          Continue Shopping
        </a>
      </div>
    </div>
  );
}
