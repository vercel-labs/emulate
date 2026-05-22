# @emulators/adapter-next

Next.js App Router proxy helpers for the native emulate runtime.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

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

For a single upstream that expects every path segment after the public route prefix, use `target`:

```typescript
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateProxy({
  routePrefix: '/emulate',
  target: 'http://127.0.0.1:4020',
})
```

Single target mode preserves every path segment. `/emulate/aws/sqs` forwards to `http://127.0.0.1:4020/aws/sqs`.

The proxy adds `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-port` when known, `x-forwarded-prefix`, `x-emulate-proxy: next`, `x-emulate-original-path`, and `x-emulate-service` for service targets.

## Vercel Preview

For zero-infra Vercel previews, use the native Go Function scaffold instead of an in-process Next.js emulator:

```bash
npx emulate vercel init --service github,google
```

The scaffold creates `api/emulate.go`, updates `go.mod`, and adds a `/emulate/:path*` rewrite in `vercel.json`.

## Compatibility Handler

`createEmulateHandler` remains exported for existing App Router routes. It accepts the old `services` config shape, starts the native runtime on first local request, and proxies each service path to that runtime. The legacy `persistence` option is rejected because state lives in the native runtime. For deployed Vercel previews, prefer `npx emulate vercel init`; alternatively set `EMULATE_<SERVICE>_URL` to a reachable native target. New code should use `createEmulateProxy` for explicit local proxying.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
