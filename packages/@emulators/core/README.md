# @emulators/core

HTTP server, in-memory store, plugin interface, and middleware for emulate service plugins.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

The internal HTTP layer builds on [Hono](https://hono.dev)'s API and design. Thank you to Yusuke Wada and the Hono contributors. See [THIRD_PARTY_NOTICES.md](https://github.com/vercel-labs/emulate/blob/main/THIRD_PARTY_NOTICES.md) for Hono's copyright and MIT license notice, also included in this npm package.

## Install

```bash
npm install @emulators/core
```

## Overview

The core provides the shared infrastructure that every `@emulators/*` service plugin builds on:

- **Store** — a generic in-memory store with typed `Collection<T>` instances supporting CRUD, indexing, filtering, and pagination
- **Server** — HTTP server with automatic port management
- **Middleware** — bearer token auth, error handling, CORS
- **UI** — shared authorization/consent page rendering with bundled fonts
- **Persistence** — pluggable save/load adapters for state durability

## Persistence

### File persistence

For local development, use the built-in file adapter:

```typescript
import { filePersistence } from '@emulators/core'

persistence: filePersistence('.emulate/state.json')
```

### Custom adapter

Any object with `load` and `save` methods works. Add `initialize` when a service generates durable identity:

```typescript
const kvAdapter = {
  async load() { return await kv.get('emulate-state') },
  async save(data: string) { await kv.set('emulate-state', data) },
  async initialize(data: string) { // atomic create-or-read
    await kv.set('emulate-state', data, { nx: true })
    return (await kv.get('emulate-state'))!
  },
}
```

The persistence adapter is called on cold start (load) and after every mutating request (save). Saves are serialized via an internal queue to prevent race conditions.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)

## Custom emulators

Pass a definition created with `defineEmulator` from `emulate` to `services[name].emulator` in framework adapters. The same definition runs through the CLI and `createEmulator({ service: definition, listen: false })` in tests. Custom entries accept an optional inspector and persistence adapter. Streamed response bodies persist state changes on completion or cancellation, and reset and close cancel active streams before cleanup. Appended Set-Cookie headers retain cookies already on a response. Keep state inside the definition's state factory, and await the handler's `close()` in tests. See the [custom emulator guide](https://emulate.dev/docs/custom-emulators).
