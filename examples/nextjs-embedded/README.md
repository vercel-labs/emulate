# Next.js Embedded Example

A Next.js app with emulators embedded directly via `@emulators/adapter-next`. No separate emulator process needed.

This demonstrates the solution for **Vercel preview deployments** where OAuth callback URLs change with every deployment. Because the emulators run on the same origin as the app, callbacks always work regardless of the deployment URL.

## Setup

```bash
# From the repo root, install dependencies
pnpm install

# Start the Next.js app (emulators are embedded, no separate process needed)
cd examples/nextjs-embedded
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and click any provider to sign in.

## How It Works

1. Emulators are served from `/emulate/github/**` and `/emulate/google/**` via a catch-all route handler in `src/app/emulate/[...path]/route.ts`.
2. Clicking a provider button redirects to `/api/auth/[provider]`, which builds the OAuth authorize URL pointing at the embedded emulator (same origin).
3. The emulator shows a user-picker page. Select a seeded user.
4. The emulator redirects back to `/api/auth/callback/[provider]` with an authorization code.
5. The callback route exchanges the code for an access token by calling the embedded emulator's token endpoint, fetches user info, and stores the session in an HTTP-only cookie.
6. The dashboard displays the authenticated user's profile and access token.

## Security Note

The session cookie in this example is a plain base64url-encoded JSON blob with no signature or encryption. This is acceptable for a local demo but not for production. In a real app, use a signed or encrypted session (e.g., iron-session or Auth.js).

## Key Differences from the OAuth Example

| | `examples/oauth` | `examples/nextjs-embedded` |
|---|---|---|
| Emulator process | Separate `npx emulate` process | Embedded in the Next.js app |
| Config | `emulate.config.yaml` + `.env.local` | Seed data in `route.ts` |
| OAuth URLs | `http://localhost:4001/login/oauth/...` | `/emulate/github/login/oauth/...` (same origin) |
| Client credentials | Must match config | `"any"` (validation skipped) |
| Preview deploys | Requires fixed callback URL | Works on any URL |
| Extra dependency | None | `@emulators/adapter-next` |

## Project Structure

```
src/
  app/
    emulate/[...path]/route.ts   # Embedded emulators (GitHub + Google)
    api/auth/
      [provider]/route.ts        # Initiates OAuth flow
      callback/[provider]/route.ts  # Handles OAuth callback
      signout/route.ts            # Clears session
    page.tsx                      # Sign-in page
    dashboard/page.tsx            # Authenticated dashboard
  lib/
    providers.ts                  # Provider config (same-origin URLs)
    session.ts                    # Cookie-based session helpers
```
