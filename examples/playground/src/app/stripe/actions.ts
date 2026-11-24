"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe/stripe";
import { origin } from "@/lib/origin";
import { getCart, clearCart } from "@/lib/stripe/cart";

export async function createCheckoutSession(): Promise<void> {
  const items = await getCart();
  if (items.length === 0) {
    redirect("/stripe/cart");
  }

  const customer = await stripe.customers.create({
    email: "shopper@example.com",
    name: "Demo Shopper",
  });

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customer.id,
      line_items: items.map((item) => ({
        price: item.priceId,
        quantity: item.quantity,
      })),
      success_url: `${origin}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/stripe/cart`,
    });
  } catch {
    await clearCart();
    redirect("/stripe");
  }

  if (!session.url) {
    redirect("/stripe/cart");
  }

  redirect(session.url);
}
