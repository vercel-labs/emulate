import { createAdapterRuntime, createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { aiPlugin } from "../index.js";
import { getAiState } from "../state.js";

const origin = "http://localhost:4000";

function putRules(baseUrl: string, requestOrigin?: string): Promise<Response> {
  const { app } = createServer(aiPlugin, { baseUrl });
  return app.request(`${origin}/_ai/rules`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
    },
    body: JSON.stringify({ rules: [] }),
  });
}

describe("AI control route origin checks", () => {
  it("rejects an Origin header when the base URL does not parse", async () => {
    const baseUrl = "http://localhost:${PORT}";
    expect((await putRules(baseUrl, origin)).status).toBe(403);
    expect((await putRules(baseUrl)).status).toBe(200);
  });

  it("allows only the matching Origin when the base URL parses", async () => {
    expect((await putRules(origin, origin)).status).toBe(200);
    expect((await putRules(origin, "http://evil.example")).status).toBe(403);
  });

  it.each([
    ["http://localhost:4000", "http://127.0.0.1:4000"],
    ["http://localhost:4000", "http://[::1]:4000"],
    ["http://127.0.0.1:4000", "http://localhost:4000"],
  ])("treats every loopback name as the same origin for base %s and Origin %s", async (baseUrl, requestOrigin) => {
    expect((await putRules(baseUrl, requestOrigin)).status).toBe(200);
  });

  it.each([
    "http://localhost:3000",
    "https://localhost:4000",
    "http://evil.example",
    "http://evil.example:4000",
    "null",
  ])("rejects Origin %s for the base URL http://localhost:4000", async (requestOrigin) => {
    expect((await putRules(origin, requestOrigin)).status).toBe(403);
  });
});

describe("AI data route origin checks", () => {
  async function serverWithStoredResponse() {
    const server = createServer(aiPlugin, { baseUrl: origin });
    const created = await server.app.request(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", input: "private prompt" }),
    });
    const { id } = (await created.json()) as { id: string };
    return { app: server.app, state: getAiState(server.store), id };
  }

  function headers(requestOrigin: string | undefined): Record<string, string> {
    return requestOrigin === undefined ? {} : { origin: requestOrigin };
  }

  it.each([
    [undefined, 200],
    [origin, 200],
    ["http://127.0.0.1:4000", 200],
    ["http://localhost:3000", 200],
    ["https://app.localhost", 200],
    ["http://[::1]:5173", 200],
    ["http://evil.example", 403],
    ["https://localhost.evil.example", 403],
    ["null", 403],
  ])("answers a stored response read from Origin %s with %i", async (requestOrigin, status) => {
    const { app, id } = await serverWithStoredResponse();
    const response = await app.request(`${origin}/v1/responses/${id}`, { headers: headers(requestOrigin) });
    expect(response.status).toBe(status);
    if (status === 403) expect(await response.text()).not.toContain("private prompt");
  });

  it("refuses every data route to another website and leaves state untouched", async () => {
    const { app, state, id } = await serverWithStoredResponse();
    const foreign = { origin: "http://evil.example", "content-type": "application/json" };
    const calls = state.calls.length;

    const generation = await app.request(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: foreign,
      body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }),
    });
    const removal = await app.request(`${origin}/v1/responses/${id}`, { method: "DELETE", headers: foreign });
    const models = await app.request(`${origin}/v1/models`, { headers: foreign });

    expect([generation.status, removal.status, models.status]).toEqual([403, 403, 403]);
    expect(state.calls).toHaveLength(calls);
    expect(state.responses.has(id)).toBe(true);
  });

  it("still refuses a page on another local port on control routes", async () => {
    expect((await putRules(origin, "http://localhost:3000")).status).toBe(403);
  });
});

describe("AI host checks", () => {
  const attacker = "http://evil.example:4000";

  async function serverWithStoredResponse(options: { baseUrl?: string; baseUrlDerived?: boolean } = {}) {
    const server = createServer(aiPlugin, { baseUrl: origin, ...options });
    const created = await server.app.request(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", input: "private prompt" }),
    });
    const { id } = (await created.json()) as { id: string };
    return { app: server.app, id };
  }

  it.each([undefined, attacker, "http://evil.example", "http://localhost:4000"])(
    "refuses an attacker host on every AI route with Origin %s",
    async (requestOrigin) => {
      const { app, id } = await serverWithStoredResponse();
      const headers: Record<string, string> = requestOrigin === undefined ? {} : { origin: requestOrigin };
      const reads = ["/_ai/calls", "/_ai/rules", "/", `/v1/responses/${id}`, "/v1/models"];
      for (const path of reads) {
        const response = await app.request(`${attacker}${path}`, { headers });
        expect(response.status).toBe(403);
        const text = await response.text();
        expect(text).not.toContain("private prompt");
        expect(text).toContain("evil.example:4000");
        expect(text).toContain("--base-url");
      }
      const post = await app.request(`${attacker}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(post.status).toBe(403);
    },
  );

  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
    "http://app.localhost:4000",
    "http://192.168.1.20:4000",
    "http://[fd00::1]:4000",
  ])("answers on %s", async (host) => {
    const { app } = await serverWithStoredResponse();
    expect((await app.request(`${host}/_ai/calls`)).status).toBe(200);
    expect((await app.request(`${host}/`)).status).toBe(200);
  });

  it("answers on the configured base URL host and no other name", async () => {
    const { app } = await serverWithStoredResponse({ baseUrl: "http://emulate.test:4000" });
    expect((await app.request("http://emulate.test:4000/_ai/calls")).status).toBe(200);
    expect((await app.request("http://emulate.test:9999/_ai/calls")).status).toBe(200);
    expect((await app.request("http://other.test:4000/_ai/calls")).status).toBe(403);
  });

  it("judges the Host header over the request URL", async () => {
    const { app } = await serverWithStoredResponse();
    const response = await app.request("http://localhost:4000/_ai/calls", { headers: { host: "evil.example:4000" } });
    expect(response.status).toBe(403);
    const ok = await app.request("http://evil.example:4000/_ai/calls", { headers: { host: "localhost:4000" } });
    expect(ok.status).toBe(200);
  });

  it("does not trust a base URL taken from the request until it is configured", async () => {
    const derived = await serverWithStoredResponse({ baseUrl: "http://evil.example:4000", baseUrlDerived: true });
    expect((await derived.app.request("http://evil.example:4000/_ai/calls")).status).toBe(403);
    expect((await derived.app.request("http://localhost:4000/_ai/calls")).status).toBe(200);

    const poisoned = { origin: "http://evil.example:4000" };
    expect((await derived.app.request("http://localhost:4000/_ai/calls", { headers: poisoned })).status).toBe(403);
    const own = { origin: "http://localhost:4000" };
    expect((await derived.app.request("http://localhost:4000/_ai/calls", { headers: own })).status).toBe(200);

    const configured = await serverWithStoredResponse({ baseUrl: "https://app.example.com", baseUrlDerived: false });
    expect((await configured.app.request("https://app.example.com/_ai/calls")).status).toBe(200);
    expect((await configured.app.request("https://evil.example/_ai/calls")).status).toBe(403);
  });
});

describe("AI host checks in the embedded runtime", () => {
  async function read(publicUrl: string | undefined, url: string): Promise<number> {
    const runtime = createAdapterRuntime(
      { services: { ai: { emulator: { plugin: aiPlugin } } }, publicUrl },
      (mount, name) => `${mount}/${name}`,
    );
    try {
      const response = await runtime.handle(new Request(url), ["ai", "_ai", "calls"], "/emulate");
      return response.status;
    } finally {
      await runtime.close();
    }
  }

  it("refuses an unconfigured DNS name even when it is the first host seen", async () => {
    expect(await read(undefined, "https://evil.example/emulate/ai/_ai/calls")).toBe(403);
    expect(await read(undefined, "http://localhost:3000/emulate/ai/_ai/calls")).toBe(200);
  });

  it("refuses a rebound Host that the framework hides behind a local request URL", async () => {
    const runtime = createAdapterRuntime(
      { services: { ai: { emulator: { plugin: aiPlugin } } } },
      (mount, name) => `${mount}/${name}`,
    );
    try {
      const response = await runtime.handle(
        new Request("http://localhost:3000/emulate/ai/_ai/calls", { headers: { host: "evil.example:3000" } }),
        ["ai", "_ai", "calls"],
        "/emulate",
      );
      expect(response.status).toBe(403);
    } finally {
      await runtime.close();
    }
  });

  it("keeps a foreign Origin forbidden after a refused foreign Host was the first request", async () => {
    const runtime = createAdapterRuntime(
      { services: { ai: { emulator: { plugin: aiPlugin } } } },
      (mount, name) => `${mount}/${name}`,
    );
    const attacker = "http://evil.example:3000";
    const local = "http://localhost:3000";
    const calls = (url: string, headers: Record<string, string> = {}) =>
      runtime.handle(new Request(`${url}/emulate/ai/_ai/calls`, { headers }), ["ai", "_ai", "calls"], "/emulate");
    const putRules = (headers: Record<string, string>) =>
      runtime.handle(
        new Request(`${local}/emulate/ai/_ai/rules`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ rules: [] }),
        }),
        ["ai", "_ai", "rules"],
        "/emulate",
      );
    try {
      expect((await calls(attacker)).status).toBe(403);
      expect((await calls(local, { origin: attacker })).status).toBe(403);
      expect((await putRules({ origin: attacker })).status).toBe(403);
      expect((await calls(local, { origin: local })).status).toBe(200);
      expect((await putRules({ origin: local })).status).toBe(200);
      expect((await calls(local)).status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it("answers on the configured public URL", async () => {
    expect(await read("https://app.example.com", "https://app.example.com/emulate/ai/_ai/calls")).toBe(200);
    expect(await read("https://app.example.com", "https://evil.example/emulate/ai/_ai/calls")).toBe(403);
  });
});
