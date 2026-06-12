# @emulators/polar

Polar.sh API emulation with organizations, products, prices, checkouts, and subscriptions.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/polar
```

## Endpoints

### Organizations
- `GET /v1/organizations` — list organizations
- `GET /v1/organizations/:id` — retrieve organization

### Products
- `GET /v1/products` — list products
- `GET /v1/products/:id` — retrieve product

### Checkouts
- `POST /v1/checkouts` — create checkout session
- `GET /v1/checkouts/:id` — retrieve checkout session

### Subscriptions
- `GET /v1/subscriptions` — list subscriptions
- `GET /v1/subscriptions/:id` — retrieve subscription

## Seed Configuration

```yaml
polar:
  organizations:
    - name: My Project
      slug: my-project
  products:
    - name: Pro Tier
      description: Support our project with a monthly subscription
      organization_slug: my-project
      prices:
        - amount: 1000
          currency: usd
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
