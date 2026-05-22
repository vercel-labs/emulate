---
name: next
description: Next.js adapter for native runtime proxying via @emulators/adapter-next and Vercel Go Function preview scaffolding. Use when the user needs to proxy a native runtime through a Next.js catch-all route, set up same-origin OAuth for Vercel preview deployments, configure Auth.js/NextAuth with emulator routes, scaffold npx emulate vercel init, or use createEmulateProxy. Triggers include "Next.js emulator", "adapter-next", "native runtime proxy", "same-origin OAuth", "Vercel preview", "Vercel Go Function", "npx emulate vercel init", "createEmulateProxy", or any task requiring emulators inside a Next.js app.
allowed-tools: Bash(npx emulate:*)
---

# Next.js Integration

The `@emulators/adapter-next` package proxies native emulate runtimes through a Next.js App Router route. Legacy in-process handler imports remain available as a compatibility facade over the native runtime.

## Vercel Go Function Preview

For zero infra Vercel preview deployments with the native Go runtime, scaffold a Go Function and rewrite:

```bash
npx emulate vercel init
```

This creates:

- `api/emulate.go`, a Vercel Go Function using `github.com/vercel-labs/emulate/vercel`
- `vercel.json`, with `/emulate/:path*` rewritten to `/api/emulate?path=:path*`
- `go.mod`, pinned to the installed `emulate` package version

The scaffold currently enables the native `apple`, `aws`, `clerk`, `github`, `google`, `microsoft`, `mongoatlas`, `okta`, `resend`, `slack`, `stripe`, and `vercel` handlers. Use `npx emulate vercel init --service github` to limit the function to one service.

State uses warm memory by default: cold starts reset to a fresh store, warm invocations reuse mutations, and concurrent function instances can diverge. For snapshots across cold starts, implement `vercel.Persistence` in `api/emulate.go` and pass it to `emulate.NewHandler`.

## Install

```bash
npm install @emulators/adapter-next
```

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

Use single `target` only when the upstream expects every path segment after the public route prefix:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  routePrefix: '/emulate',
  target: 'http://127.0.0.1:4020',
})
```

Single target mode preserves every path segment. `/emulate/aws/sqs` forwards to `http://127.0.0.1:4020/aws/sqs`.

## Auth.js / NextAuth Configuration

Point your provider at emulator paths on the same origin:

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

## Compatibility Handler

`createEmulateHandler` remains exported for existing App Router routes. It accepts the old `services` config shape, starts the native runtime on first local request, and proxies each service path to that runtime. The legacy `persistence` option is rejected because state lives in the native runtime. For deployed Vercel previews, prefer `npx emulate vercel init`; alternatively set `EMULATE_<SERVICE>_URL` to a reachable native target. New code should use `createEmulateProxy` for explicit local proxying.
