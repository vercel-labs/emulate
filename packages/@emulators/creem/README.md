# @emulators/creem

Stateful Creem Test Mode emulation with hosted product checkout, signed webhooks, subscriptions, cancellation, and a local inspector.

## Install

```bash
npm install @emulators/creem
```

## Start

```bash
npx emulate --service creem
```

## Seed configuration

```yaml
creem:
  products:
    - id: prod_console_dev
      name: YapHaus managed relay
      amount: 6900
      currency: USD
      return_url: http://127.0.0.1:4322/welcome
  webhooks:
    - url: http://127.0.0.1:8787/webhooks/creem
      events: ["*"]
      secret: local-webhook-secret
```

No real payment is processed. Completing hosted checkout emits a `checkout.completed` event with a `Creem-Signature` HMAC header. Use `POST /_creem/subscriptions/:id/cancel` to emit the terminal cancellation lifecycle event.
