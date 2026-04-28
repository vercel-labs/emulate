"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";

export async function createCheckoutSession() {
  // Look up the seeded price. In a real app this would be hard-coded or
  // looked up from a CMS; here we let the emulator be the source of truth.
  const prices = await stripe.prices.list({ limit: 1 });
  const price = prices.data[0];
  if (!price) {
    throw new Error("No price seeded; check src/app/emulate/[...path]/route.ts");
  }

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  redirect(session.url);
}
