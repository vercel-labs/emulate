import Stripe from "stripe";

export const stripe = new Stripe("sk_emulated_key", {
  host: process.env.STRIPE_HOST ?? "localhost",
  port: parseInt(process.env.STRIPE_PORT ?? "3000", 10),
  protocol: (process.env.STRIPE_PROTOCOL as "http" | "https") ?? "http",
});
