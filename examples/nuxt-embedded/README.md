# Nuxt Embedded Example

A Nuxt app with emulators embedded directly via `@emulators/adapter-nuxt`. No separate emulator process needed.

This demonstrates the solution for **preview deployments** where OAuth callback URLs change with every deployment. Because the emulators run on the same origin as the app, callbacks always work regardless of the deployment URL.

## Setup

```bash
# From the repo root, install dependencies
pnpm install

# Start the Nuxt app (emulators are embedded, no separate process needed)
cd examples/nuxt-embedded
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and click any provider to sign in.

## How It Works

1. Emulators are served from `/emulate/github/**` and `/emulate/google/**` via a catch-all server route in `server/routes/emulate/[...path].ts`.
2. Clicking a provider button navigates to `/api/auth/[provider]`, which builds the OAuth authorize URL pointing at the embedded emulator (same origin).
3. The emulator shows a user-picker page. Select a seeded user.
4. The emulator redirects back to `/api/auth/callback/[provider]` with an authorization code.
5. The callback route exchanges the code for an access token by calling the embedded emulator's token endpoint, fetches user info, and stores the session in an HTTP-only cookie.
6. The dashboard displays the authenticated user's profile and access token.

## Nuxt Config

`nuxt.config.ts` wraps the config with `withEmulate(...)` so Nitro traces the `@emulators/core` assets (the emulator UI fonts) into production builds.

## Security Note

The session cookie in this example is a plain base64url-encoded JSON blob with no signature or encryption. This is acceptable for a local demo but not for production. In a real app, use a signed or encrypted session (e.g. `nuxt-auth-utils`).

## Key Differences from the OAuth Example

| | `examples/oauth` | `examples/nuxt-embedded` |
|---|---|---|
| Emulator process | Separate `npx emulate` process | Embedded in the Nuxt app |
| Config | `emulate.config.yaml` + `.env.local` | Seed data in `[...path].ts` |
| OAuth URLs | `http://localhost:4001/login/oauth/...` | `/emulate/github/login/oauth/...` (same origin) |
| Client credentials | Must match config | `"any"` (validation skipped) |
| Preview deploys | Requires fixed callback URL | Works on any URL |
| Extra dependency | None | `@emulators/adapter-nuxt` |

## Project Structure

```
app/
  app.vue                          # Root component + global styles
  pages/
    index.vue                      # Sign-in page
    dashboard.vue                  # Authenticated dashboard
server/
  routes/emulate/[...path].ts      # Embedded emulators (GitHub + Google)
  api/
    auth/
      [provider].get.ts            # Initiates OAuth flow
      callback/[provider].get.ts   # Handles OAuth callback
      signout.post.ts              # Clears session
    providers.get.ts               # Provider display info for the UI
    session.get.ts                 # Returns the current session
  utils/
    providers.ts                   # Provider config (same-origin URLs)
    session.ts                     # Cookie-based session helpers
nuxt.config.ts                     # Wrapped with withEmulate(...)
```
