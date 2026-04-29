export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { CheckCircle } from "lucide-react";
import { stripe } from "@/lib/stripe";
import { getOrder } from "@/lib/orders";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
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
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardHeader className="items-center text-center">
          <CheckCircle className="mb-2 size-12 text-green-600" />
          <CardTitle className="text-2xl">Payment successful</CardTitle>
          <CardDescription>Your order has been confirmed</CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {customer && (
            <>
              {customer.name && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="font-medium">{customer.name}</span>
                </div>
              )}
              {customer.email && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Email</span>
                  <span>{customer.email}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Session</span>
            <span className="font-mono text-xs">{session.id}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium capitalize">{session.payment_status}</span>
          </div>
          {order?.completedAt && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Confirmed at</span>
              <span>{new Date(order.completedAt).toLocaleTimeString()}</span>
            </div>
          )}
          {order?.paymentIntentId && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Payment Intent</span>
              <span className="font-mono text-xs">{order.paymentIntentId}</span>
            </div>
          )}
          {order?.chargeId && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Charge</span>
              <span className="font-mono text-xs">{order.chargeId}</span>
            </div>
          )}
          {session.amount_total != null && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-bold">{formatCurrency(session.amount_total, session.currency ?? "usd")}</span>
            </div>
          )}
        </CardContent>

        <CardFooter className="justify-center">
          <a href="/" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
            Continue shopping
          </a>
        </CardFooter>
      </Card>
    </div>
  );
}
