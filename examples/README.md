# Examples

Runnable apps built against the emulators. Each has its own README with setup
steps.

| Example | Services | Mode | Shows |
|---|---|---|---|
| [oauth](./oauth) | GitHub, Google, Vercel | Standalone CLI | OAuth sign-in against a separate `npx emulate` process |
| [nextjs-embedded](./nextjs-embedded) | GitHub, Google | Embedded (Next.js) | Emulators on the app's own origin via `@emulators/adapter-next` — survives changing preview URLs |
| [nuxt-embedded](./nuxt-embedded) | GitHub, Google | Embedded (Nuxt) | The same, via `@emulators/adapter-nuxt` |
| [stripe-checkout](./stripe-checkout) | Stripe | Embedded (Next.js) | Checkout session, hosted payment page, webhook handling |
| [resend-magic-link](./resend-magic-link) | Resend | Embedded (Next.js) | Magic-link sign-in, reading sent mail back from the emulator inbox |
| [twilio-sms-verification](./twilio-sms-verification) | Twilio | Embedded (Next.js) | SMS verification codes, and simulating the inbound code |
| [vercel-blob-sharing](./vercel-blob-sharing) | Vercel Blob | Embedded (Next.js) | File upload and sharing against emulated Blob storage |

## Before your first run

All examples import `@emulators/*` packages from their `dist/` output, which is
gitignored and has no `postinstall` step. Build the workspace once from the repo
root:

```bash
pnpm install
pnpm build
```

Skipping this produces `Cannot find module '.../dist/index.js'` on `pnpm dev`.

Five of the seven examples serve the app through
[portless](https://github.com/vercel-labs/portless) (`npm i -g portless`), which
assigns a random local port and a stable HTTPS hostname — so they are **not** on
`http://localhost:3000`. Each README states the URL to open. The two that do use
`localhost:3000` are `resend-magic-link` and `twilio-sms-verification`.

## Standalone vs embedded

- **Standalone** runs `npx emulate` as a separate process; your app talks to it over `http://localhost:<port>`. Closest to how a real third-party API is reached.
- **Embedded** mounts the emulators inside the app itself under `/emulate/**`, so they share the app's origin. Callback URLs keep working even when the deployment URL changes, which is what makes preview deployments practical.

See [Next.js Integration](https://emulate.dev/docs/nextjs) and
[Nuxt Integration](https://emulate.dev/docs/nuxt).
