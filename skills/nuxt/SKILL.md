---
name: nuxt
description: Nuxt adapter for embedding emulators directly in a Nuxt app via @emulators/adapter-nuxt. Use when the user needs to embed emulators in Nuxt, set up same-origin OAuth for preview deployments, create an emulate catch-all server route, configure persistence for embedded Nuxt emulators, or wrap nuxt.config with withEmulate. Triggers include "Nuxt emulator", "adapter-nuxt", "embedded emulator", "same-origin OAuth", "createEmulateHandler", "withEmulate", or any task requiring emulators inside a Nuxt app.
allowed-tools: Bash(npx emulate:*)
---

# Nuxt Integration

The `@emulators/adapter-nuxt` package embeds emulators directly into a Nuxt app, running them on the same origin. This is useful for preview deployments where OAuth callback URLs change with every deployment.

## Install

```bash
npm install @emulators/adapter-nuxt @emulators/github @emulators/google
```

Only install the emulators you need. Each `@emulators/*` package is published independently, keeping server bundles small.

## Server Route

Create a named catch-all route that serves emulator traffic:

```typescript
// server/routes/emulate/[...path].ts
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'
import * as google from '@emulators/google'

export default defineEventHandler(createEmulateHandler({
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
}))
```

This creates these routes:

- `/emulate/github/**` serves the GitHub emulator
- `/emulate/google/**` serves the Google emulator

## Nuxt Config

Emulator UI pages use bundled fonts. Wrap your Nuxt config so Nitro traces the core package assets into production builds:

```typescript
// nuxt.config.ts
import { withEmulate } from '@emulators/adapter-nuxt'

export default defineNuxtConfig(withEmulate({
  // your normal Nuxt config
}))
```

## OAuth Configuration

Point your OAuth provider at the emulator paths on the same origin:

```typescript
const baseUrl = process.env.NUXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export const githubOAuth = {
  clientId: 'any-value',
  clientSecret: 'any-value',
  authorizationUrl: `${baseUrl}/emulate/github/login/oauth/authorize`,
  tokenUrl: `${baseUrl}/emulate/github/login/oauth/access_token`,
  userInfoUrl: `${baseUrl}/emulate/github/user`,
}
```

No `oauth_apps` need to be seeded. When none are configured, the emulator skips `client_id`, `client_secret`, and `redirect_uri` validation.

## Persistence

By default, emulator state is in-memory and resets on every cold start. To persist state across restarts, pass a `persistence` adapter.

### Nitro Storage

```typescript
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'

const storageAdapter = {
  async load() { return await useStorage('emulate').getItem<string>('state') },
  async save(data: string) { await useStorage('emulate').setItem('state', data) },
}

export default defineEventHandler(createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: storageAdapter,
}))
```

### File Persistence

For local development, `@emulators/core` ships a file-based adapter:

```typescript
import { filePersistence } from '@emulators/core'

persistence: filePersistence('.emulate/state.json'),
```

### How Persistence Works

- **Cold start**: The adapter loads state from the persistence adapter. If found, it restores the full Store and token map. If not found, it seeds from config and saves the initial state.
- **After mutating requests** (POST, PUT, PATCH, DELETE): State is saved. Saves are serialized via an internal queue to prevent race conditions.
- **No persistence configured**: Falls back to pure in-memory. Seed data re-initializes on every cold start.

## How It Works

1. **Incoming request**: `/emulate/github/login/oauth/authorize?client_id=...`
2. **Parse**: service = `github`, rest = `/login/oauth/authorize`
3. **Strip prefix**: A new `Request` is created with the stripped path and forwarded to the GitHub service app
4. **Rewrite response**: HTML `action` and `href` attributes, CSS `url()` font references, and `Location` headers get the service prefix prepended
5. **Persist**: After mutating requests, state is saved via the persistence adapter

## Limitations

- Requires a Node-compatible Nuxt server runtime since emulators use Node APIs
- Concurrent serverless instances writing to the same persistence adapter use last write wins semantics, which is acceptable for dev and preview traffic

## Config Reference

### `createEmulateHandler(config, options?)`

| Field | Type | Description |
|-------|------|-------------|
| `services` | `Record<string, EmulatorEntry>` | Map of service name to emulator config |
| `persistence?` | `PersistenceAdapter` | Optional persistence adapter for state across cold starts |

Each `EmulatorEntry`:

| Field | Type | Description |
|-------|------|-------------|
| `emulator` | `EmulatorModule` | The emulator package, such as `import * as github from '@emulators/github'` |
| `seed?` | `Record<string, unknown>` | Seed data matching the service's config schema |

Options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `param` | `string` | `"path"` | Named catch-all route param |
| `routePrefix` | `string` | detected | Path prefix where the catch-all route is mounted |

### `withEmulate(nuxtConfig)`

Wraps a Nuxt config to include `@emulators/core` assets in Nitro's production trace. Call it inside `defineNuxtConfig` in `nuxt.config.ts`.

### `PersistenceAdapter`

```typescript
interface PersistenceAdapter {
  load(): Promise<string | null>
  save(data: string): Promise<void>
}
```
