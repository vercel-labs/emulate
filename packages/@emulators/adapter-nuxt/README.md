# @emulators/adapter-nuxt

Nuxt server route integration for emulate. Embed emulators directly into your Nuxt app so they run on the same origin, which keeps OAuth callbacks stable for preview deployments.

## Install

```bash
npm install @emulators/adapter-nuxt
```

Only install the emulators you need alongside the adapter:

```bash
npm install @emulators/adapter-nuxt @emulators/github @emulators/google
```

## Server Route

Create a named catch-all route that serves emulator traffic:

```typescript
// server/routes/emulate/[...path].ts
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'
import * as google from '@emulators/google'

export const emulator = createEmulateHandler({
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

export default defineEventHandler(emulator)
```

This creates these routes:

- `/emulate/github/**` serves the GitHub emulator
- `/emulate/google/**` serves the Google emulator

## GitHub App private keys

GitHub App seeds may omit `private_key`. The adapter generates the key asynchronously and exposes generated material only through the server-side handler function:

```typescript
const [appKey] = await emulator.generatedSecrets()
```

Explicit keys are never returned. With persistence configured, the generated identity is saved with emulator state and restored across cold starts. Keep the persistence backend private because its snapshot contains the App signing key. Do not expose generated secrets through an event handler or public runtime config.

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

```typescript
import { createEmulateHandler } from '@emulators/adapter-nuxt'
import * as github from '@emulators/github'

const storageAdapter = {
  async load() { return await redis.get('emulate-state') },
  async save(data: string) { await redis.set('emulate-state', data) },
  async initialize(data: string) {
    await redis.set('emulate-state', data, { nx: true })
    const selected = await redis.get('emulate-state')
    if (selected === null) throw new Error('Failed to initialize emulator state')
    return selected
  },
}

export default defineEventHandler(createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: storageAdapter,
}))
```

For local development, `@emulators/core` ships a file-based adapter:

```typescript
import { filePersistence } from '@emulators/core'

persistence: filePersistence('.emulate/state.json'),
```

`initialize` must atomically create the initial value or return the value another instance created first. It is required when generated GitHub App identities may be used. The built-in file adapter implements this contract.

## Custom Route Param

The adapter reads the `path` param from `server/routes/emulate/[...path].ts`. If you use a different catch-all name, pass it as the second argument:

```typescript
export default defineEventHandler(createEmulateHandler(config, { param: 'slug' }))
```

If the mount path cannot be detected from the URL, pass `routePrefix`:

```typescript
export default defineEventHandler(createEmulateHandler(config, { routePrefix: '/api/emulate' }))
```
