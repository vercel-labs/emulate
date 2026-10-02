import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, createEmulator, defineEmulator, waitForListening } from "../api.js";
import { startCommand } from "../commands/start.js";
import { prepareProject } from "../project-runner.js";

const counter = defineEmulator({
  name: "counter",
  state: () => ({ count: 0 }),
  setup({ app, state }) {
    app.get("/", (c) => c.json(state));
  },
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function observeListeners(): Server[] {
  return vi.spyOn(Server.prototype, "listen").mock.contexts as Server[];
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  { mode: "loopback by default", hostname: undefined, address: "127.0.0.1" },
  { mode: "explicit network access", hostname: "0.0.0.0", address: "0.0.0.0" },
])("listener binding: $mode", ({ hostname, address }) => {
  it.each(["builtin", "custom"])("starts a %s through createEmulator", async (kind) => {
    const servers = observeListeners();
    const emulator =
      kind === "builtin"
        ? await createEmulator({ service: "resend", port: 0, hostname })
        : await createEmulator({ service: counter, port: 0, hostname });
    try {
      const server = servers[0];
      expect(server.address()).toMatchObject({ address });
      expect(new URL(emulator.url).hostname).toBe("localhost");
      const response = await fetch(`${emulator.url}${kind === "builtin" ? "/inbox" : "/"}`);
      expect(response.status).toBe(200);
    } finally {
      await emulator.close();
    }
  });

  it("starts built-in and custom services from project configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-binding-"));
    let run: Awaited<ReturnType<typeof prepareProject>> | undefined;
    try {
      const [builtinPort, customPort] = await Promise.all([unusedPort(), unusedPort()]);
      await mkdir(join(directory, "node_modules"));
      await symlink(
        resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
        join(directory, "node_modules/emulate"),
        "junction",
      );
      const config = join(directory, "config.json");
      await writeFile(
        join(directory, "counter.mjs"),
        'import { defineEmulator } from "emulate"; export default defineEmulator({ name: "counter", state: () => ({ count: 0 }), setup({ app, state }) { app.get("/", c => c.json(state)) } })',
      );
      await writeFile(
        config,
        JSON.stringify({
          services: {
            resend: { emulator: "resend", port: builtinPort },
            counter: { emulator: "./counter.mjs", port: customPort },
          },
        }),
      );
      const servers = observeListeners();
      run = await prepareProject({ port: 4000, config, host: hostname });
      await run.start();
      expect(servers).toHaveLength(2);
      for (const server of servers) expect(server.address()).toMatchObject({ address });
      expect((await fetch(`http://localhost:${builtinPort}/inbox`)).status).toBe(200);
      expect(await (await fetch(`http://localhost:${customPort}/`)).json()).toEqual({ count: 0 });
    } finally {
      await run?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts services through the legacy seed runner", async () => {
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");
    const servers = observeListeners();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const port = await unusedPort();
      await startCommand({ port, service: "resend", host: hostname });
      const server = servers[0];
      await waitForListening(server);
      expect(server.address()).toMatchObject({ address });
      expect((await fetch(`http://localhost:${port}/inbox`)).status).toBe(200);
    } finally {
      await Promise.all(servers.map(closeHttpServer));
      for (const listener of process.listeners("SIGINT")) {
        if (!beforeSigint.includes(listener)) process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!beforeSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
      }
    }
  });
});
