---
name: custom-apis
description: Build and share third-party HTTP API emulators with emulate. Use to emulate an external provider, add a custom service plugin, model stateful vendor endpoints, configure custom seeds, or package an emulator. For an existing built-in service, use that service's skill.
---

# Custom emulators

Bring a third-party provider's HTTP API into local development, tests, and agent sandboxes. Implement the provider behavior your integration uses, run it alongside built-in services, and share the definition as a package.

Use the project's existing package manager for changes. End-user CLI examples use `npx emulate` because bare `emulate` is a zsh built-in. Requires Node 24 or later.

Start from the scaffold when creating an emulator:

```bash
npm install -D emulate
npx emulate init --custom inventory
npx emulate start --watch
```

The scaffold creates a TypeScript definition and a Node test for an inventory API. Adapt its routes, state, and test to the third-party provider. It adds an entry to a discovered YAML, JSON, TypeScript, or JavaScript config, preserving existing services. For an unusual executable config, follow the manual import and registration instructions printed by the command. `init` prints the generated test path; use the service URL and Inspector link printed by `start` for requests because the port depends on the config.

Define the service with `defineEmulator` imported from `emulate`. `state()` returns fresh JSON-compatible data, and synchronous `setup({ app, state, baseUrl, signal, onDispose })` registers handlers. State is inferred. Implement observable state transitions, validation, and errors from the actual API contract. Use author-controlled response shapes and IDs.

Keep mutable state in `state()`, not module-level variables. `seed` fully replaces initial state. Add `validateSeed(value)` for external fixtures. Snapshots are detached and versioned; increment `stateVersion` when changing persisted shape. Reset restores the captured seed and recreates handlers. Restore changes current state without changing the reset baseline.

The router provides `get`, `post`, `put`, `patch`, `delete`, `on`, `use`, `onError`, and `notFound`. Use `c.req` for headers, parameters, query, JSON, text, forms, or bytes, and return a native Response or `c.json/text/html/body/redirect`. Append cookies with `c.header('Set-Cookie', value, { append: true })` to retain cookies already on the response. It is not a complete Hono implementation. There is no implicit custom authentication or rate limit. Keep `/_emulate` reserved for management.

Use `baseUrl` for advertised URLs, the lifecycle signal for asynchronous work, and `onDispose` for cleanup. An `await` can interleave concurrent handlers; protect domain invariants accordingly.

Register definitions in `defineConfig({ services: { inventory: { emulator: inventory } } })`. YAML/JSON entries can use local module paths or installed packages. Paths resolve from the config project. The CLI uses Node built-ins with support for TypeScript path aliases and inherited JSONC tsconfig files. Node 26 accepts erasable TypeScript only; compile enums and parameter properties to JavaScript before loading them. Node 24 also supports native TypeScript transforms. Use erasable TypeScript for definitions shared with native Node tests; JSX and compiler plugins are unsupported. Built-ins can appear alongside custom services. Instance names must not replace built-in names.

Validate the API in process:

```typescript
const api = await createEmulator({ service: inventory, listen: false })
try {
  await api.request('/reservations', { method: 'POST' })
  const state = await (await api.request('/inventory')).json()
  await api.reset()
} finally {
  await api.close()
}
```

Import `createEmulator` from `emulate`. Use `port: 0` and the returned `url` for HTTP SDK tests. Run the scaffold's test with `node --test emulators/inventory.test.ts`. Test reads after writes, domain errors, reset, and independent instances. Do not describe an API as implemented based only on matching response schemas.

The CLI inspector shows requests, routes, and state at the printed `/_emulate` URL. Structured previews and state redact token and secret fields such as `access_token`, `refresh_token`, and `client_secret`. Successful watch reloads reset the run to seed. With config auto-discovery, watch mode detects recognized config files created after startup. Creating a missing local import also retries a failed reload, including when the import is outside the config directory. Declare files read at runtime with config `watch` paths. Inspector is opt-in in programmatic and embedded usage. Reuse the same definition in Next/Nuxt adapter entries; root-relative redirects remain under the service mount while custom HTML stays unchanged. Export `OPTIONS` from the Next.js handler so preflight requests and custom OPTIONS routes reach the emulator. Close handlers in test teardown.

For persistence, use a custom entry's file path or `filePersistence(path)` from `emulate`. Automatic saves cover completed requests, including state changes made while streaming a response body, reset/restore, and controlled shutdown. Reset and close cancel active streams before running `onDispose` callbacks; pass the lifecycle signal to asynchronous work. Persistence is process-local coordination, not distributed locking. Publish plugins as built JavaScript plus declarations with an appropriate `emulate` peer dependency.

Reference: https://emulate.dev/docs/custom-emulators
