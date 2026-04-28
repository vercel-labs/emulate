import Stripe from "stripe";

// The Stripe Node SDK speaks plain HTTP to host:port/v1/* with no path prefix
// support. We point it at the Next.js server itself; next.config.ts rewrites
// /v1/* into /emulate/stripe/v1/*, so the request lands on the embedded
// emulator with zero code changes from a real Stripe integration.
const port = Number(process.env.PORT ?? 3000);

export const stripe = new Stripe("sk_test_emulated", {
  host: "localhost",
  port,
  protocol: "http",
});
