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
          app.get("/redirect", (c) => c.redirect("/html"));
          app.get("/mounted-redirect", (c) => c.redirect(`${new URL(baseUrl).pathname}/html`));
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
        const redirect = await runtime.request("counter/redirect");
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("Location")).toBe("/local/counter/html");
        const mountedRedirect = await runtime.request("counter/mounted-redirect");
        expect(mountedRedirect.headers.get("Location")).toBe("/local/counter/html");
        const binary = new Uint8Array([0, 255, 10, 128]);
        expect(
          new Uint8Array(
            await (await runtime.request("counter/binary", { method: "POST", body: binary })).arrayBuffer(),
          ),
        ).toEqual(binary);
        const html = await (await runtime.request("counter/_emulate?tab=state")).text();
        expect(html).toContain("http://localhost/local/counter/_emulate/reset");
        expect((await runtime.request("other/_emulate")).status).toBe(404);
        const reset = await runtime.request("counter/_emulate/reset", { method: "POST" });
        expect(reset.status).toBe(303);
        expect(reset.headers.get("Location")).toBe("http://localhost/local/counter/_emulate?tab=state");
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

    it("persists shared custom state after stream completion and cancellation", async () => {
      let saved = null;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const definition = defineEmulator({
        name: "counter",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.get(
            "/stream",
            () =>
              new Response(
                new ReadableStream({
                  async pull(controller) {
                    await gate;
                    state.count++;
                    controller.enqueue(new TextEncoder().encode("done"));
                    controller.close();
                  },
                }),
              ),
          );
          app.get(
            "/cancel",
            () =>
              new Response(
                new ReadableStream({
                  pull: () => new Promise(() => {}),
                  cancel() {
                    state.count++;
                  },
                }),
              ),
          );
        },
      });
      const runtime = create({
        services: { counter: { emulator: definition } },
        persistence: {
          load: async () => saved,
          save: async (value) => {
            saved = value;
          },
        },
      });
      const savedCount = () => JSON.parse(saved).custom.counter.state.count;
      try {
        const streamed = await runtime.request("counter/stream");
        expect(savedCount()).toBe(0);
        release();
        expect(await streamed.text()).toBe("done");
        expect(savedCount()).toBe(1);

        const cancelled = await runtime.request("counter/cancel");
        await cancelled.body.cancel();
        expect(savedCount()).toBe(2);

        const head = await runtime.request("counter/cancel", { method: "HEAD" });
        expect(head.body).toBeNull();
        await expect.poll(savedCount).toBe(3);
      } finally {
        release();
        await runtime.close();
      }
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
