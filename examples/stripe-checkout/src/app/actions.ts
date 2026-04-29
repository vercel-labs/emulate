"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getCart, clearCart } from "@/lib/cart";

export async function createCheckoutSession(): Promise<void> {
  const items = await getCart();
  if (items.length === 0) {
    redirect("/cart");
  }

  const port = process.env.PORT ?? "3000";
  const origin = `http://localhost:${port}`;

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
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart`,
    });
  } catch {
    await clearCart();
    redirect("/");
  }

  if (!session.url) {
    redirect("/cart");
  }

  redirect(session.url);
}
