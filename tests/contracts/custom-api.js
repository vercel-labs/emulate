export function customApiContract({ describe, it, expect, defineEmulator, create }) {
  describe("custom adapter API", () => {
    it("shares one definition, isolates instances, preserves payloads, and mounts inspection", async () => {
      const definition = defineEmulator({
        name: "counter",
        state: () => ({ count: 0 }),
        setup({ app, state, baseUrl }) {
          app.post("/increment", (c) => {
            state.count++;
            return c.json({ count: state.count, baseUrl });
          });
          app.get("/", (c) => c.json(state));
          app.get("/html", (c) => c.html('<a href="/original">original</a>'));
          app.post("/binary", async (c) =>
            c.body(await c.req.arrayBuffer(), 200, { "Content-Type": "application/octet-stream" }),
          );
        },
      });
      const runtime = create({
        services: { counter: { emulator: definition, inspector: true }, other: { emulator: definition } },
      });
      try {
        const response = await runtime.request("counter/increment", { method: "POST" });
        expect(await response.json()).toEqual({ count: 1, baseUrl: "http://localhost/local/counter" });
        expect(await (await runtime.request("other")).json()).toEqual({ count: 0 });
        expect(await (await runtime.request("counter/html")).text()).toBe('<a href="/original">original</a>');
        const binary = new Uint8Array([0, 255, 10, 128]);
        expect(
          new Uint8Array(
            await (await runtime.request("counter/binary", { method: "POST", body: binary })).arrayBuffer(),
          ),
        ).toEqual(binary);
        const html = await (await runtime.request("counter/_emulate?tab=state")).text();
        expect(html).toContain("http://localhost/local/counter/_emulate/reset");
        expect((await runtime.request("other/_emulate")).status).toBe(404);
        expect((await runtime.request("counter/_emulate/reset", { method: "POST" })).status).toBe(303);
        expect(await (await runtime.request("counter")).json()).toEqual({ count: 0 });
      } finally {
        await runtime.close();
      }
    });

    it("restores custom state alongside legacy snapshot envelopes", async () => {
      let saved = null;
      const persistence = {
        load: async () => saved,
        save: async (value) => {
          saved = value;
        },
      };
      const definition = defineEmulator({
        name: "counter",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.get("/", (c) => c.json(state));
          app.post("/", (c) => {
            state.count++;
            return c.json(state);
          });
        },
      });
      const config = { services: { counter: { emulator: definition } }, persistence };
      const a = create(config);
      await a.request("counter", { method: "POST" });
      await a.close();
      const b = create(config);
      expect(await (await b.request("counter")).json()).toEqual({ count: 1 });
      await b.close();
      expect((await b.request("counter")).status).toBe(503);
      await b.close();
    });

    it("rejects corrupt custom snapshots and failed initial saves", async () => {
      const definition = defineEmulator({
        name: "counter",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.get("/", (c) => c.json(state));
        },
      });
      for (const saved of [
        "",
        "invalid",
        JSON.stringify({ store: { collections: {}, data: {} }, tokens: {}, custom: { counter: null } }),
      ]) {
        let writes = 0;
        const runtime = create({
          services: { counter: { emulator: definition } },
          persistence: {
            load: async () => saved,
            save: async () => {
              writes++;
            },
          },
        });
        await expect(runtime.request("counter")).rejects.toThrow();
        expect(writes).toBe(0);
        await runtime.close();
      }
      const runtime = create({
        services: { counter: { emulator: definition } },
        persistence: {
          load: async () => null,
          save: async () => {
            throw new Error("storage unavailable");
          },
        },
      });
      await expect(runtime.request("counter")).rejects.toThrow("storage unavailable");
      await expect(runtime.close()).rejects.toThrow("storage unavailable");
    });
  });
}
