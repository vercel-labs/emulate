# OAuth Example

A Next.js app demonstrating OAuth sign-in with three emulated providers:
**GitHub**, **Google**, and **Vercel**.

No real accounts or API keys needed — everything runs against the local emulator.

## Prerequisites

This example is served through [portless](https://github.com/vercel-labs/portless),
which gives it a stable HTTPS hostname:

```bash
npm i -g portless
portless proxy start
```

## Setup

```bash
# From the repo root: install, then build the workspace emulator packages.
# The examples import @emulators/* from dist/, which is gitignored and has no
# postinstall step, so this build is required before the first run.
pnpm install
pnpm build

# Start the emulators. A bare `npx emulate` runs all 14 services, which puts
# Vercel on 4000, GitHub on 4001 and Google on 4002 — exactly the ports this
# example falls back to.
npx emulate
```

In a separate terminal:

```bash
cd examples/oauth
pnpm dev
```

Open **https://oauth-demo.emulate.localhost** and click any provider to sign in.
portless prints the URL on startup; it also assigns a random local port, so
`http://localhost:3000` is *not* where this app is served.

## Configuration

The app runs with no configuration at all: every value below has a working
fallback, and with no seed config the emulator accepts any `client_id`.

Create `examples/oauth/.env.local` only if you need to override something —
most importantly `NEXT_PUBLIC_APP_URL`, which must match the URL your browser
actually uses, because it is what the OAuth `redirect_uri` is built from.

```bash
# The app's own public URL. Must match where the browser reaches the app,
# or the OAuth callback will redirect to the wrong host.
NEXT_PUBLIC_APP_URL=https://oauth-demo.emulate.localhost

# Emulator base URLs (defaults shown; correct for a bare `npx emulate`)
VERCEL_EMULATOR_URL=http://localhost:4000
GITHUB_EMULATOR_URL=http://localhost:4001
GOOGLE_EMULATOR_URL=http://localhost:4002

# OAuth client credentials (defaults shown). Any value works unless you seed
# `oauth_apps` / `integrations`, which switches the emulator to strict validation.
GITHUB_CLIENT_ID=emu_github_client_id
GITHUB_CLIENT_SECRET=emu_github_client_secret
GOOGLE_CLIENT_ID=emu_google_client_id
GOOGLE_CLIENT_SECRET=emu_google_client_secret
VERCEL_CLIENT_ID=emu_vercel_client_id
VERCEL_CLIENT_SECRET=emu_vercel_client_secret
```

If you do seed OAuth apps in a config file, the `client_id` and `redirect_uris`
there must match these values exactly — otherwise the authorize request is
rejected. Note also that a config file containing only some service keys acts as
an implicit `--service`, so it would start fewer services and shift the ports
above.

## How It Works

1. Clicking a provider button redirects to `/api/auth/[provider]`, which builds the OAuth authorize URL and redirects the browser to the emulator.
2. The emulator shows a user-picker page. Select a seeded user.
3. The emulator redirects back to `/api/auth/callback/[provider]` with an authorization code.
4. The callback route exchanges the code for an access token, fetches user info, and stores the session in an HTTP-only cookie.
5. The dashboard displays the authenticated user's profile and access token.

## Links

- [Emulator configuration](https://emulate.dev/docs/configuration)
- [Connecting your app](https://emulate.dev/docs/connecting)
- [Troubleshooting](https://emulate.dev/docs/troubleshooting)
