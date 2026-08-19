# @emulators/adapter-next

Next.js App Router integration for emulate. Embed emulators directly in your Next.js app so they run on the same origin, solving the Vercel preview deployment problem where OAuth callback URLs change with every deployment.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/adapter-next
```

Only install the emulators you need alongside the adapter:

```bash
npm install @emulators/adapter-next @emulators/github @emulators/google
```

## Route handler

Create a catch-all route that serves emulator traffic:

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
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

export const { GET, POST, PUT, PATCH, DELETE } = emulator
```

## GitHub App private keys

GitHub App seeds may omit `private_key`. The adapter generates the key asynchronously and exposes generated material only through the server-side handler object:

```typescript
const [appKey] = await emulator.generatedSecrets()
```

Explicit keys are never returned. With persistence configured, the generated identity is saved with emulator state and restored across cold starts. Keep the persistence backend private because its snapshot contains the App signing key. Do not import the route module from Client Components or return generated secrets from a route.

## Auth.js / NextAuth configuration

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

## Font files in serverless

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

By default, emulator state is in-memory and resets on every cold start. To persist state across restarts, pass a `persistence` adapter:

```typescript
import { createEmulateHandler } from '@emulators/adapter-next'
import * as github from '@emulators/github'

const kvAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data: string) { await kv.set('emulate-state', data) },
  async initialize(data: string) {
    await kv.set('emulate-state', data, { nx: true })
    const selected = await kv.get('emulate-state')
    if (selected === null) throw new Error('Failed to initialize emulator state')
    return selected
  },
}

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: { github: { emulator: github } },
  persistence: kvAdapter,
})
```

For local development, `@emulators/core` ships `filePersistence`:

```typescript
import { filePersistence } from '@emulators/core'

// ...
persistence: filePersistence('.emulate/state.json'),
```

`initialize` must atomically create the initial value or return the value another instance created first. It is required when generated GitHub App identities may be used. The built-in file adapter implements this contract.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
