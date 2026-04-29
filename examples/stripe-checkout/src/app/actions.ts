"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getCart, setCart, type CartItem } from "@/lib/cart";

export async function addToCartAction(formData: FormData) {
  const priceId = formData.get("priceId") as string;
  const productName = formData.get("productName") as string;
  const unitAmount = parseInt(formData.get("unitAmount") as string, 10);
  const currency = formData.get("currency") as string;

  const items = await getCart();
  const existing = items.find((i) => i.priceId === priceId);
  if (existing) {
    existing.quantity += 1;
  } else {
    items.push({ priceId, productName, unitAmount, currency, quantity: 1 });
  }
  await setCart(items);
}

export async function updateQuantityAction(formData: FormData) {
  const priceId = formData.get("priceId") as string;
  const delta = parseInt(formData.get("delta") as string, 10);

  let items = await getCart();
  const item = items.find((i) => i.priceId === priceId);
  if (item) {
    const next = item.quantity + delta;
    if (next <= 0) {
      items = items.filter((i) => i.priceId !== priceId);
    } else {
      item.quantity = next;
    }
  }
  await setCart(items);
}

export async function removeFromCartAction(formData: FormData) {
  const priceId = formData.get("priceId") as string;
  const items = await getCart();
  await setCart(items.filter((i) => i.priceId !== priceId));
}

export async function clearCartAction() {
  await setCart([]);
}

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
    // Price IDs become stale when the emulator restarts; clear the cart and
    // let the user re-add items with the freshly seeded prices.
    await setCart([]);
    redirect("/");
  }

  if (!session.url) {
    redirect("/cart");
  }

  redirect(session.url);
}
