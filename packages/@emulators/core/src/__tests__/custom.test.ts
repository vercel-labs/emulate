import { describe, it, expect, vi } from "vitest";
import { defineEmulator, createCustomRuntime, cloneState } from "../custom.js";

const inventory = defineEmulator({
  name: "inventory",
  state: () => ({ stock: 2, nextId: 1, reservations: [] as Array<{ id: string }> }),
  setup({ app, state }) {
    app.get("/inventory", (c) => c.json({ stock: state.stock }));
    app.post("/reservations", (c) => {
      if (!state.stock) return c.json({ error: "out_of_stock" }, 409);
      const item = { id: `r_${state.nextId++}` };
      state.stock--;
      state.reservations.push(item);
      return c.json(item, 201);
    });
    app.delete("/reservations/:id", (c) => {
      const index = state.reservations.findIndex((item) => item.id === c.req.param("id"));
      if (index < 0) return c.notFound();
      state.reservations.splice(index, 1);
      state.stock++;
      return c.body(null, 204);
    });
    app.post("/echo", async (c) => c.json(await c.req.json()));
    app.on("OPTIONS", "/options", (c) => c.body(null, 204));
  },
});

describe("custom runtime", () => {
  it("preserves methods, parameters, forms, bytes, middleware headers, and repeated cookies", async () => {
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "protocol",
        state: () => ({}),
        cors: false,
        setup({ app }) {
          app.use(async (c, next) => {
            await next();
            c.header("X-Middleware", "yes");
            if (c.req.path === "/native-cookies") c.header("Set-Cookie", "middleware=1; Path=/", { append: true });
          });
          app.put("/items/:id", async (c) =>
            c.json({ id: c.req.param("id"), tags: c.req.queries("tag"), text: await c.req.text() }),
          );
          app.patch("/form", async (c) => c.json(await c.req.parseBody()));
          app.post("/bytes", async (c) =>
            c.body(await c.req.arrayBuffer(), 200, { "Content-Type": "application/octet-stream" }),
          );
          app.get("/cookies", (c) => {
            c.header("Set-Cookie", "a=1; Path=/", { append: true });
            c.header("Set-Cookie", "b=2; Expires=Wed, 21 Oct 2030 07:28:00 GMT", { append: true });
            return c.text(c.req.header("Cookie") ?? "");
          });
          app.get("/native-cookies", () => new Response("ok", { headers: { "Set-Cookie": "route=1; Path=/" } }));
          app.on("OPTIONS", "/options", (c) => c.body(null, 204, { Allow: "GET, OPTIONS" }));
        },
      }),
      { inspector: true },
    );
    try {
      const put = await runtime.request("/items/hello%20world?tag=a&tag=b", { method: "PUT", body: "plain text" });
      expect(await put.json()).toEqual({ id: "hello world", tags: ["a", "b"], text: "plain text" });
      expect(put.headers.get("X-Middleware")).toBe("yes");
      expect(
        await (await runtime.request("/form", { method: "PATCH", body: new URLSearchParams("key=a&key=b") })).json(),
      ).toEqual({ key: ["a", "b"] });
      const form = new FormData();
      form.append("name", "sample");
      expect(await (await runtime.request("/form", { method: "PATCH", body: form })).json()).toEqual({
        name: "sample",
      });
      const bytes = new Uint8Array([0, 255, 13, 128]);
      expect(
        new Uint8Array(await (await runtime.request("/bytes", { method: "POST", body: bytes })).arrayBuffer()),
      ).toEqual(bytes);
      const cookies = await runtime.request("/cookies", { headers: { Cookie: "input=1" } });
      expect(cookies.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Expires=Wed, 21 Oct 2030 07:28:00 GMT"]);
      expect(await cookies.text()).toBe("input=1");
      const nativeCookies = await runtime.request("/native-cookies");
      expect(nativeCookies.headers.getSetCookie()).toEqual(["route=1; Path=/", "middleware=1; Path=/"]);
      expect((await runtime.request("/options", { method: "OPTIONS" })).headers.get("Allow")).toBe("GET, OPTIONS");
    } finally {
      await runtime.close();
    }
  });

  it("reports failed saves, recovers on the next request, and persists mutations before thrown errors", async () => {
    let saved: string | null = null;
    let failing = false;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "durable",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.post("/", () => {
            state.count++;
            throw new Error("handler failed");
          });
          app.get("/", (c) => c.json(state));
        },
      }),
      {
        persistence: {
          load: async () => saved,
          save: async (data) => {
            if (failing) throw new Error("storage offline");
            saved = data;
          },
        },
      },
    );
    try {
      failing = true;
      expect(await (await runtime.request("/", { method: "POST" })).json()).toEqual({
        error: "Could not persist emulator state",
      });
      expect(JSON.parse(saved!).state.count).toBe(0);
      failing = false;
      expect(await (await runtime.request("/")).json()).toEqual({ count: 1 });
      expect(JSON.parse(saved!).state.count).toBe(1);
    } finally {
      await runtime.close();
      log.mockRestore();
    }
  });

  it("keeps reset usable after cleanup fails and flushes state even when close rejects", async () => {
    let saved = "";
    let disposals = 0;
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "cleanup",
        state: () => ({ count: 0 }),
        setup({ app, state, onDispose }) {
          app.post("/", (c) => {
            state.count++;
            return c.json(state);
          });
          onDispose(() => {
            disposals++;
            throw new Error("cleanup failed");
          });
        },
      }),
      {
        persistence: {
          load: async () => null,
          save: async (data) => {
            saved = data;
          },
        },
      },
    );
    await runtime.request("/", { method: "POST" });
    await expect(runtime.reset()).rejects.toThrow("Cleanup failed");
    expect(await (await runtime.request("/", { method: "POST" })).json()).toEqual({ count: 1 });
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await expect(closing).rejects.toThrow("Could not close");
    expect(disposals).toBe(2);
    expect(JSON.parse(saved).state.count).toBe(1);
    expect((await runtime.request("/")).status).toBe(503);
  });

  it("rejects async setup and invalid options without unhandled rejections", async () => {
    const definition = defineEmulator({
      name: "async",
      state: () => ({}),
      async setup() {
        throw new Error("async failure");
      },
    });
    await expect(createCustomRuntime(definition)).rejects.toThrow("setup() must be synchronous");
    await expect(createCustomRuntime(inventory, { inspector: { maxRequests: NaN } })).rejects.toThrow("maxRequests");
    await expect(createCustomRuntime(inventory, { shutdownTimeout: Infinity })).rejects.toThrow("shutdownTimeout");
    await expect(createCustomRuntime({ ...inventory, apiVersion: 2 } as any)).rejects.toThrow("API version 2");
  });

  it("supports stateful workflows, reset, snapshots, and independent instances", async () => {
    const a = await createCustomRuntime(inventory);
    const b = await createCustomRuntime(inventory);
    try {
      expect(await (await a.request("/reservations", { method: "POST" })).json()).toEqual({ id: "r_1" });
      const checkpoint = a.snapshot();
      await a.request("/reservations", { method: "POST" });
      expect((await a.request("/reservations", { method: "POST" })).status).toBe(409);
      expect(await (await b.request("/inventory")).json()).toEqual({ stock: 2 });
      expect((await a.request("/reservations/r_1", { method: "DELETE" })).status).toBe(204);
      await a.restore(checkpoint);
      checkpoint.state.stock = 100;
      expect(a.snapshot().state.stock).toBe(1);
      await a.reset();
      expect(a.snapshot().state).toEqual({ stock: 2, nextId: 1, reservations: [] });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("captures a seed once, accepts complete overrides, and rejects invalid snapshots", async () => {
    const factory = vi.fn(() => ({ id: Math.random() }));
    const def = defineEmulator({ name: "random", state: factory, setup() {} });
    const runtime = await createCustomRuntime(def);
    const initial = runtime.snapshot();
    await runtime.reset();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toEqual(initial);
    await expect(runtime.restore({ ...initial, stateVersion: 2 })).rejects.toThrow("Incompatible snapshot");
    await runtime.close();
  });

  it("uses neutral responses and returns client errors for malformed JSON", async () => {
    const runtime = await createCustomRuntime(inventory);
    const response = await runtime.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(response.headers.has("X-RateLimit-Limit")).toBe(false);
    expect(await response.json()).toEqual({ error: "Invalid JSON request body" });
    expect(await (await runtime.request("/missing")).json()).toEqual({ error: "Not Found" });
    expect(await (await runtime.request("/inventory", { method: "HEAD" })).text()).toBe("");
    await runtime.close();
  });

  it("handles a rejected stream cancellation on HEAD without an unhandled rejection", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "streaming-head",
        state: () => ({}),
        setup({ app }) {
          app.get("/stream", () => new Response(new ReadableStream({ cancel })));
        },
      }),
    );
    try {
      const response = await runtime.request("/stream", { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      await runtime.close();
    }
  });

  it("waits for HEAD response cancellation before cleanup", async () => {
    let started!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disposed = vi.fn();
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "streaming-head-cleanup",
        state: () => ({}),
        setup({ app, onDispose }) {
          onDispose(disposed);
          app.get(
            "/stream",
            () =>
              new Response(
                new ReadableStream({
                  pull: () => new Promise<void>(() => {}),
                  async cancel() {
                    started();
                    await cancellationGate;
                  },
                }),
              ),
          );
        },
      }),
    );
    try {
      const response = await runtime.request("/stream", { method: "HEAD" });
      expect(response.body).toBeNull();
      await cancellationStarted;
      const reset = runtime.reset();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disposed).not.toHaveBeenCalled();
      release();
      await reset;
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      release();
      await runtime.close();
    }
  });

  it("validates seeds and rejects unsupported state with a path", async () => {
    const def = defineEmulator({
      name: "validated",
      state: () => ({ count: 0 }),
      validateSeed(value) {
        if (!value || typeof value !== "object" || !("count" in value) || typeof value.count !== "number")
          throw new Error("seed.count must be a number");
        return { count: value.count };
      },
      setup() {},
    });
    await expect(createCustomRuntime(def, { seed: { count: "bad" } as any })).rejects.toThrow("seed.count");
    expect(() => cloneState({ nested: { date: new Date() } })).toThrow("state.nested.date");
    expect(() => cloneState({ x: NaN })).toThrow("state.x");
    expect(() => cloneState({ x: undefined })).toThrow("state.x");
    const circular: any = {};
    circular.loop = circular;
    expect(() => cloneState(circular)).toThrow("Circular");
  });

  it("persists mutations on reads, errors, reset, and restore and rejects bad saved state", async () => {
    let data: string | null = null;
    const persistence = {
      load: async () => data,
      save: async (value: string) => {
        data = value;
      },
    };
    const def = defineEmulator({
      name: "counter",
      state: () => ({ count: 0 }),
      setup({ app, state }) {
        app.get("/", (c) => {
          state.count++;
          return c.json(state);
        });
        app.post("/error", (c) => {
          state.count++;
          return c.json({ error: "business_error" }, 409);
        });
      },
    });
    const a = await createCustomRuntime(def, { persistence });
    await a.request("/");
    await a.request("/error", { method: "POST" });
    await a.close();
    const b = await createCustomRuntime(def, { persistence });
    expect(b.snapshot().state.count).toBe(2);
    await b.reset();
    expect(JSON.parse(data!).state.count).toBe(0);
    await b.close();
    data = "bad";
    await expect(createCustomRuntime(def, { persistence })).rejects.toThrow("Cannot restore");
    expect(data).toBe("bad");
  });

  it("drains cancelled requests before replacing state and disposes every generation once", async () => {
    const disposed = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const def = defineEmulator({
      name: "slow",
      state: () => ({ count: 0 }),
      setup({ app, state, signal, onDispose }) {
        onDispose(disposed);
        app.post("/", async (c) => {
          started();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          state.count++;
          return c.json(state);
        });
      },
    });
    const runtime = await createCustomRuntime(def);
    const request = runtime.request("/", { method: "POST" });
    await ready;
    await runtime.reset();
    await request;
    expect(runtime.snapshot().state.count).toBe(0);
    expect(disposed).toHaveBeenCalledTimes(1);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it("persists mutations made while streaming a response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = "";
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "stream-persistence",
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
                    controller.enqueue(new TextEncoder().encode("complete"));
                    controller.close();
                  },
                }),
              ),
          );
        },
      }),
      {
        persistence: {
          load: async () => null,
          save: async (value) => {
            saved = value;
          },
        },
      },
    );
    try {
      const response = await runtime.request("/stream");
      expect(JSON.parse(saved).state.count).toBe(0);
      release();
      expect(await response.text()).toBe("complete");
      expect(runtime.snapshot().state.count).toBe(1);
      expect(JSON.parse(saved).state.count).toBe(1);
    } finally {
      release();
      await runtime.close();
    }
  });

  it("persists a stream's final state after another request saves an intermediate state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = "";
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "stream-interleaving",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.get("/set", (c) => {
            state.count = 1;
            return c.text("set");
          });
          app.get(
            "/stream",
            () =>
              new Response(
                new ReadableStream({
                  async pull(controller) {
                    await gate;
                    state.count = 0;
                    controller.close();
                  },
                }),
              ),
          );
        },
      }),
      {
        persistence: {
          load: async () => null,
          save: async (value) => {
            saved = value;
          },
        },
      },
    );
    try {
      const stream = await runtime.request("/stream");
      expect(await (await runtime.request("/set")).text()).toBe("set");
      expect(JSON.parse(saved).state.count).toBe(1);
      release();
      expect(await stream.text()).toBe("");
      expect(JSON.parse(saved).state.count).toBe(0);
    } finally {
      release();
      await runtime.close();
    }
  });

  it("persists state changed by response body cancellation", async () => {
    let saved = "";
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "stream-cancel-persistence",
        state: () => ({ count: 0 }),
        setup({ app, state }) {
          app.get(
            "/stream",
            () =>
              new Response(
                new ReadableStream({
                  pull: () => new Promise<void>(() => {}),
                  cancel() {
                    state.count++;
                  },
                }),
              ),
          );
        },
      }),
      {
        persistence: {
          load: async () => null,
          save: async (value) => {
            saved = value;
          },
        },
      },
    );
    try {
      const response = await runtime.request("/stream");
      expect(JSON.parse(saved).state.count).toBe(0);
      await response.body!.cancel();
      expect(JSON.parse(saved).state.count).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("waits for stream cancellation before disposing a generation", async () => {
    let cancelling!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      cancelling = resolve;
    });
    let release!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disposed = vi.fn();
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "stream-cleanup",
        state: () => ({}),
        setup({ app, onDispose }) {
          onDispose(disposed);
          app.get(
            "/stream",
            () =>
              new Response(
                new ReadableStream({
                  pull() {
                    return new Promise<void>(() => {});
                  },
                  async cancel() {
                    cancelling();
                    await cancellationGate;
                  },
                }),
              ),
          );
        },
      }),
    );
    try {
      const response = await runtime.request("/stream");
      const reset = runtime.reset();
      await cancellationStarted;
      expect(disposed).not.toHaveBeenCalled();
      release();
      await reset;
      expect(disposed).toHaveBeenCalledOnce();
      await expect(response.text()).rejects.toThrow();
    } finally {
      release();
      await runtime.close();
    }
  });

  it("renders redacted inspection without changing JSON/binary responses", async () => {
    const runtime = await createCustomRuntime(inventory, {
      inspector: { maxRequests: 2 },
      baseUrl: "http://localhost/emulate/inventory",
    });
    const res = await runtime.request("http://localhost/echo", {
      method: "POST",
      headers: { authorization: "secret-token", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hidden", message: "<hello>" }),
    });
    expect(await res.json()).toEqual({ password: "hidden", message: "<hello>" });
    const html = await (await runtime.request("http://localhost/_emulate")).text();
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("secret-token");
    expect(html).not.toContain("hidden");
    expect(html).toContain("&lt;hello&gt;");
    expect(html).toContain("http://localhost/emulate/inventory/_emulate/reset");
    const reset = await runtime.request("http://localhost/_emulate/reset", { method: "POST" });
    expect(reset.status).toBe(303);
    await runtime.close();
  });

  it("redacts token and secret fields across paths, headers, bodies, and state", async () => {
    const runtime = await createCustomRuntime(
      defineEmulator({
        name: "secrets",
        state: () => ({ access_token: "state-secret" }),
        setup({ app }) {
          app.post("/echo", async (c) => c.json({ ...(await c.req.json()), clientSecret: "response-secret" }));
        },
      }),
      { inspector: true },
    );
    try {
      const response = await runtime.request("/echo?client_secret=query-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Refresh-Token": "header-secret" },
        body: JSON.stringify({ refresh_token: "body-secret", token_type: "bearer" }),
      });
      expect(await response.json()).toEqual({
        refresh_token: "body-secret",
        token_type: "bearer",
        clientSecret: "response-secret",
      });
      const requests = await (await runtime.request("/_emulate")).text();
      const state = await (await runtime.request("/_emulate?tab=state")).text();
      for (const secret of ["query-secret", "header-secret", "body-secret", "response-secret", "state-secret"])
        expect(requests + state).not.toContain(secret);
      expect(requests).toContain("bearer");
      expect(requests).toContain("[redacted]");
    } finally {
      await runtime.close();
    }
  });

  it("rejects conflicting and reserved routes without affecting built-in router defaults", async () => {
    await expect(
      createCustomRuntime(
        defineEmulator({
          name: "duplicate",
          state: () => ({}),
          setup({ app }) {
            app.get("/items/:id", (c) => c.json({}));
            app.get("/items/:name", (c) => c.json({}));
          },
        }),
      ),
    ).rejects.toThrow("Duplicate route");
    await expect(
      createCustomRuntime(
        defineEmulator({
          name: "reserved",
          state: () => ({}),
          setup({ app }) {
            app.get("/_emulate", (c) => c.json({}));
          },
        }),
      ),
    ).rejects.toThrow("reserved");
  });
});
