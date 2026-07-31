---
name: creem
description: Emulated Creem Test Mode checkout and subscription lifecycle for local development. Use for Creem hosted checkout, signed webhooks, subscriptions, cancellation, and offline payment integration testing.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Creem emulator

Start the service from an installed package:

```bash
npx emulate --service creem
```

Configure products and signed webhook destinations in `emulate.config.yaml`. Open `/test/payment/:productId` to complete a test checkout. Cancel a resulting subscription with `POST /_creem/subscriptions/:subscriptionId/cancel`.

No real payment is processed and no Creem credential is required.
