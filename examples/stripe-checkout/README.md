# Stripe Checkout with emulate

A Next.js storefront demonstrating the full [Stripe Checkout](https://stripe.com/docs/payments/checkout) flow against the emulated Stripe API from `emulate`.

No real payments are processed. The emulator runs in-process, seeds products and prices, hosts a checkout page, and fires webhooks on completion.

## How it works

1. The home page fetches products and prices from the emulated Stripe API via the official `stripe` SDK
2. Users add items to a client-side cart (persisted in localStorage)
3. Clicking "Checkout" creates a Stripe Checkout Session through a server action
4. The browser redirects to the emulated checkout page where the user clicks "Pay and Complete"
5. The emulator marks the session as paid and fires a `checkout.session.completed` webhook to `/api/webhooks/stripe`
6. The webhook handler records the order in memory
7. The user is redirected to the success page showing order confirmation

The Stripe SDK is configured with `host: localhost` and `protocol: http` so all API calls stay local. A thin proxy route at `/v1/[...path]` forwards SDK requests to the embedded emulator at `/emulate/stripe/v1/*`.

## Getting started

From the repository root:

```bash
pnpm install
pnpm --filter stripe-checkout dev
```

Open [http://localhost:3000](http://localhost:3000).

## Seeded data

Four products with prices are seeded automatically:

| Product | Price |
|---------|-------|
| Emulate T-Shirt | $25.00 |
| Emulate Mug | $15.00 |
| Emulate Sticker Pack | $8.00 |
| Emulate Hoodie | $50.00 |

## Project structure

```
src/
  app/
    page.tsx                    Product catalog (server component)
    actions.ts                  Server action: create checkout session
    cart/
      page.tsx                  Cart page wrapper
      cart-page.tsx             Client component with cart UI
    success/
      page.tsx                  Order confirmation (server component)
    api/
      webhooks/
        stripe/
          route.ts              Webhook handler for checkout.session.completed
    v1/
      [...path]/route.ts        Proxy: forwards Stripe SDK calls to the emulator
    emulate/
      [...path]/route.ts        Embedded emulator (Stripe)
  lib/
    stripe.ts                   Stripe SDK client (pointed at localhost)
    cart.tsx                    CartProvider context + useCart hook
    orders.ts                   In-memory order store
  components/
    add-to-cart.tsx             "Add to cart" button (client component)
    cart-button.tsx             Header cart icon with badge
    ui/
      button.tsx                Button primitive
      button-variants.ts        Button variant styles
      card.tsx                  Card layout components
```
