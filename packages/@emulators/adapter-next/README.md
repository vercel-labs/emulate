# @emulators/adapter-next

Next.js App Router integration for emulate. Use embedded mode to run JavaScript emulators directly inside your app, or proxy mode to expose a separately running native runtime on the same origin.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/adapter-next
```

Only install the emulators you need alongside the adapter:

```bash
npm install @emulators/adapter-next @emulators/github @emulators/google
```

## Embedded route handler

Create a catch-all route that serves emulator traffic in-process:

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

Embedded mode is the current zero-infra path for Vercel preview deployments. The emulator code runs in the Next.js function, so OAuth callback URLs can point at the preview origin.

## Native runtime proxy

Use `createEmulateProxy` when a native runtime is running separately and the Next.js route should forward requests to it:

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateProxy } from '@emulators/adapter-next'

export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    resend: 'http://127.0.0.1:4018',
    aws: 'http://127.0.0.1:4020',
  },
})
```

With `targets`, the first path segment selects the service and is stripped before forwarding. `/emulate/resend/emails` forwards to `http://127.0.0.1:4018/emails`, while response `Location` headers and HTML links are rewritten back to `/emulate/resend/*`.

If multiple services share one native runtime URL, keep using `targets` and point each service at that runtime when the runtime expects service-local paths:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  targets: {
    resend: 'http://127.0.0.1:4000',
    aws: 'http://127.0.0.1:4000',
  },
})
```

Use single `target` only when the upstream expects every path segment after the public route prefix:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  routePrefix: '/emulate',
  target: 'http://127.0.0.1:4020',
})
```

Single target mode preserves every path segment. `/emulate/aws/sqs` forwards to `http://127.0.0.1:4020/aws/sqs`.

The proxy adds `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-port` when known, `x-forwarded-prefix`, `x-emulate-proxy: next`, `x-emulate-original-path`, and `x-emulate-service` for service targets. For deployed previews, the target URL must be reachable from the Next.js serverless function.

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

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
