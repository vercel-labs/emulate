import { createEmulateHandler } from "@emulators/adapter-next";
import * as stripe from "@emulators/stripe";

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  // Required because we rewrite `/v1/*` → `/emulate/stripe/v1/*` so the Stripe
  // SDK can talk to the emulator without per-call URL config. Rewritten requests
  // expose only the original URL, so the mount point must be declared explicitly.
  routePrefix: "/emulate",
  services: {
    stripe: {
      emulator: stripe,
      seed: {
        products: [{ name: "Lifetime License" }],
        prices: [{ product_name: "Lifetime License", currency: "usd", unit_amount: 2900 }],
      },
      // The emulator's webhook dispatcher needs to know where to deliver
      // events. Relative URLs are resolved against the running origin so the
      // same config works on localhost and Vercel preview deployments.
      webhooks: [{ url: "/webhooks/stripe", events: ["*"] }],
    },
  },
});
