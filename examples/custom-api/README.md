# Custom inventory API

A complete stateful HTTP API defined in one TypeScript module. Reservations decrement stock, cancellation restores it, and exhaustion returns HTTP 409. The same module runs in the CLI and in a test without opening a port.

Requires Node 24 or later. From the repository root, run `pnpm install` and `pnpm --filter emulate... build`. Then run `pnpm --filter custom-api-example dev` and open the printed inspector URL.

The example uses erasable TypeScript and runs on Node 26. Node 26 requires erasable syntax for local TypeScript configs and definitions; compile enums and parameter properties to JavaScript first.

For an existing project outside this repository:

```bash
npm install -D emulate
npx emulate init --custom inventory
npx emulate start --watch
```

Try the generated API:

```bash
curl -X POST http://localhost:4000/reservations
curl http://localhost:4000/inventory
curl -X DELETE http://localhost:4000/reservations/r_1
```

Open `http://localhost:4000/_emulate` to inspect requests, routes, and state. Reset restores the captured initial seed. Saving the emulator or an imported local file resets the run to the newly configured seed.

Run the generated test with `node --test emulators/inventory.test.ts`. It checks reservations, cancellation, exhaustion, and reset. The test has no server or framework dependency.

The config can add built-ins with entries such as `github: { emulator: "github", port: 4001 }`. See the [custom emulator guide](https://emulate.dev/docs/custom-emulators) for validation, snapshots, persistence, adapters, and publishing modules.
