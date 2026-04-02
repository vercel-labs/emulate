---
name: next
description: Next.js adapter for embedding emulators directly in a Next.js app via @emulators/adapter-next. Use when the user needs to embed emulators in Next.js, set up same-origin OAuth for Vercel preview deployments, create an emulate catch-all route handler, configure Auth.js/NextAuth with embedded emulators, add persistence to embedded emulators, or wrap next.config with withEmulate. Triggers include "Next.js emulator", "adapter-next", "embedded emulator", "same-origin OAuth", "Vercel preview", "createEmulateHandler", "withEmulate", or any task requiring emulators inside a Next.js app.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*)
---

# Next.js Integration

The `@emulators/adapter-next` package embeds emulators directly into a Next.js App Router app, running them on the same origin. This is particularly useful for Vercel preview deployments where OAuth callback URLs change with every deployment.

## Install

```bash
npm install @emulators/adapter-next @emulators/github @emulators/google
```

Only install the emulators you need. Each `@emulators/*` package is published independently, keeping serverless bundles small.

## Route Handler

Create a catch-all route that serves emulator traffic:

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as github from '@emulators/github'
import * as google from '@emulators/google'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    github: {
      emulator: github,
      seed: {
        users: [{ login: 'octocat', name: 'The Octocat' }],
        repos: [{ owner: 'octocat', name: 'hello-world', auto_init: true }],
      },
    },
    google: {
      emulator: google,
      seed: {
        users: [{ email: 'test@example.com', name: 'Test User' }],
      },
    },
  },
})
```

This creates the following routes:

- `/emulate/github/**` serves the GitHub emulator
- `/emulate/google/**` serves the Google emulator

## Auth.js / NextAuth Configuration

Point your provider at the emulator paths on the same origin:

```typescript
import GitHub from 'next-auth/providers/github'

const baseUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'

GitHub({
  clientId: 'any-value',
  clientSecret: 'any-value',
  authorization: { url: `${baseUrl}/emulate/github/login/oauth/authorize` },
  token: { url: `${baseUrl}/emulate/github/login/oauth/access_token` },
  userinfo: { url: `${baseUrl}/emulate/github/user` },
})
```

No `oauth_apps` need to be seeded. When none are configured, the emulator skips `client_id`, `client_secret`, and `redirect_uri` validation.

## Font Tracing for Serverless

Emulator UI pages use bundled fonts. Wrap your Next.js config to include them in the serverless trace:

```typescript
// next.config.mjs
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  // your normal Next.js config
})
```

If you mount the catch-all at a custom path, pass the matching prefix:

```typescript
export default withEmulate(nextConfig, { routePrefix: '/api/emulate' })
```

## Persistence

By default, emulator state is in-memory and resets on every cold start. To persist state across restarts, pass a `persistence` adapter.

### Custom Adapter (Vercel KV, Redis, etc.)

```typescript
import { createEmulateHandler } from '@emulators/adapter-next'
import * as github from '@emulators/github'

const kvAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data: string) { await kv.set('emulate-state', data) },
}

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: kvAdapter,
})
```

### File Persistence (Local Dev)

For local development, `@emulators/core` ships a file-based adapter:

```typescript
import { filePersistence } from '@emulators/core'

// persists to a JSON file
persistence: filePersistence('.emulate/state.json'),
```

### How Persistence Works

- **Cold start**: The adapter loads state from the persistence adapter. If found, it restores the full Store and token map (skipping seed). If not found, it seeds from config and saves the initial state.
- **After mutating requests** (POST, PUT, PATCH, DELETE): State is saved. Saves are serialized via an internal queue to prevent race conditions.
- **No persistence configured**: Falls back to pure in-memory. Seed data re-initializes on every cold start.

## How It Works

1. **Incoming request**: `/emulate/github/login/oauth/authorize?client_id=...`
2. **Parse**: service = `github`, rest = `/login/oauth/authorize`
3. **Strip prefix**: A new `Request` is created with the stripped path and forwarded to the GitHub Hono app
4. **Rewrite response**: HTML `action` and `href` attributes, CSS `url()` font references, and `Location` headers get the service prefix prepended
5. **Persist**: After mutating requests, state is saved via the persistence adapter

## Limitations

- Requires the Node.js runtime (not Edge) since emulators use `crypto.randomBytes`
- Concurrent serverless instances writing to the same persistence adapter use last-write-wins semantics (acceptable for dev/preview traffic)

## Config Reference

### `createEmulateHandler(config)`

| Field | Type | Description |
|-------|------|-------------|
| `services` | `Record<string, EmulatorEntry>` | Map of service name to emulator config |
| `persistence?` | `PersistenceAdapter` | Optional persistence adapter for state across cold starts |

Each `EmulatorEntry`:

| Field | Type | Description |
|-------|------|-------------|
| `emulator` | `EmulatorModule` | The emulator package (e.g. `import * as github from '@emulators/github'`) |
| `seed?` | `Record<string, unknown>` | Seed data matching the service's config schema |

### `withEmulate(nextConfig, options?)`

Wraps a Next.js config to include emulator font files in the serverless output trace. Call it around your exported config in `next.config.mjs` or `next.config.ts`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `routePrefix` | `string` | `"/emulate"` | The path prefix where the catch-all route is mounted |

### `PersistenceAdapter`

```typescript
interface PersistenceAdapter {
  load(): Promise<string | null>
  save(data: string): Promise<void>
}
```

The built-in `filePersistence(path)` from `@emulators/core` provides a file-based adapter for local development.
