import { describe, it, expect } from "vitest";
import { createEmulator, defineEmulator, defineConfig } from "../api.js";

const definition = defineEmulator({
  name: "counter",
  state: () => ({ count: 0 }),
  setup({ app, state, baseUrl }) {
    app.get("/", (c) => c.json({ count: state.count, baseUrl }));
    app.post("/", (c) => {
      state.count++;
      return c.json(state);
    });
  },
});

describe("public custom API", () => {
  it("uses the same definition in process and on an assigned port", async () => {
    const local = await createEmulator({ service: definition, listen: false });
    const network = await createEmulator({ service: definition, port: 0 });
    try {
      expect("url" in local).toBe(false);
      expect(network.url).not.toContain(":0");
      const response = await fetch(network.url, { method: "POST" });
      expect(await response.json()).toEqual({ count: 1 });
      expect(await (await fetch(network.url)).json()).toMatchObject({ baseUrl: network.url });
      expect(local.snapshot().state.count).toBe(0);
      await network.reset();
      expect(network.snapshot().state.count).toBe(0);
    } finally {
      await Promise.all([local.close(), network.close()]);
    }
  });

  it("surfaces occupied-port failures and retains inline seed/config typing", async () => {
    const server = await createEmulator({ service: definition, port: 0 });
    try {
      await expect(
        createEmulator({ service: definition, port: Number(new URL(server.url).port) }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await server.close();
    }
    const config = defineConfig({ services: { custom: { emulator: definition, seed: { count: 4 } } } });
    const instance = await createEmulator({
      service: config.services.custom.emulator,
      seed: config.services.custom.seed,
      listen: false,
    });
    expect(instance.snapshot().state.count).toBe(4);
    await instance.close();
  });
});
