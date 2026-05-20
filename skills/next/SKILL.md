---
name: next
description: Next.js adapter for embedded emulators, native runtime proxying via @emulators/adapter-next, and Vercel Go Function preview scaffolding. Use when the user needs to embed emulators in Next.js, proxy a native runtime through a Next.js catch-all route, set up same-origin OAuth for Vercel preview deployments, configure Auth.js/NextAuth with emulator routes, add persistence to embedded emulators, scaffold npx emulate vercel init, or wrap next.config with withEmulate. Triggers include "Next.js emulator", "adapter-next", "embedded emulator", "native runtime proxy", "same-origin OAuth", "Vercel preview", "Vercel Go Function", "npx emulate vercel init", "createEmulateHandler", "createEmulateProxy", "withEmulate", or any task requiring emulators inside a Next.js app.
allowed-tools: Bash(npx emulate:*)
---

# Next.js Integration

The `@emulators/adapter-next` package supports two App Router modes. Embedded mode runs JavaScript emulators directly inside the Next.js app. Proxy mode exposes a separately running native runtime on the same origin.

## Vercel Go Function Preview

For zero infra Vercel preview deployments with the native Go runtime, scaffold a Go Function and rewrite:

```bash
npx emulate vercel init
```

This creates:

- `api/emulate.go`, a Vercel Go Function using `github.com/vercel-labs/emulate/vercel`
- `vercel.json`, with `/emulate/:path*` rewritten to `/api/emulate?path=:path*`
- `go.mod`, pinned to the installed `emulate` package version

The scaffold currently enables the native `apple`, `aws`, `github`, `google`, `microsoft`, `resend`, `slack`, and `vercel` handlers. Use `npx emulate vercel init --service github` to limit the function to one service.

State uses warm memory by default: cold starts reset to a fresh store, warm invocations reuse mutations, and concurrent function instances can diverge. For snapshots across cold starts, implement `vercel.Persistence` in `api/emulate.go` and pass it to `emulate.NewHandler`.

## Install

```bash
npm install @emulators/adapter-next @emulators/github @emulators/google
```

Only install the emulators you need. Each `@emulators/*` package is published independently, keeping serverless bundles small.

## Embedded Route Handler

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

This creates the following routes:

- `/emulate/github/**` serves the GitHub emulator
- `/emulate/google/**` serves the Google emulator

Embedded mode is the broadest zero infra path for JavaScript emulator packages on Vercel preview deployments. The emulator code runs in the Next.js function, so OAuth callback URLs can point at the preview origin. For native Go `apple`, `aws`, `github`, `google`, `microsoft`, `resend`, `slack`, and `vercel` previews, use `npx emulate vercel init`.

## Native Runtime Proxy

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
3. **Strip prefix**: A new `Request` is created with the stripped path and forwarded to the GitHub service app
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

### `createEmulateProxy(config)`

| Field | Type | Description |
|-------|------|-------------|
| `target?` | `string | URL | EmulateProxyTargetConfig` | Single runtime target. All path segments after the route prefix are preserved. |
| `targets?` | `Record<string, string | URL | EmulateProxyTargetConfig>` | Service-specific targets. The first path segment selects the target and is stripped by default. |
| `routePrefix?` | `string` | Explicit public route prefix. If omitted, the adapter derives it from the incoming request and catch-all params. |
| `headers?` | `ProxyHeaders | ProxyHeaderFactory` | Extra headers added to every proxied request. |

Each `EmulateProxyTargetConfig`:

| Field | Type | Description |
|-------|------|-------------|
| `target` | `string | URL` | Runtime base URL from the Next.js server's perspective. |
| `pathPrefix?` | `string` | Optional path segment to prepend before the forwarded path. |
| `stripServicePrefix?` | `boolean` | For `targets`, defaults to `true`. Set to `false` only when the target expects the service segment. |
| `headers?` | `ProxyHeaders | ProxyHeaderFactory` | Extra headers added for this target. |

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
