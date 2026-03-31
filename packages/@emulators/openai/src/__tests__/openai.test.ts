import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, createApiErrorHandler, createErrorHandler, authMiddleware, type TokenMap } from "@emulators/core";
import { openaiPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4100";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", {
    login: "testuser",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  openaiPlugin.register(app as any, store, webhooks, base, tokenMap);
  openaiPlugin.seed?.(store, base);

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

describe("OpenAI plugin integration", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    store = result.store;
  });

  describe("POST /v1/chat/completions (non-streaming)", () => {
    it("returns a chat completion for a matching prompt", async () => {
      const res = await app.request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBe("Hello! I'm the emulated assistant.");
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(body.usage).toBeDefined();
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    });

    it("returns default response for unmatched prompt", async () => {
      seedFromConfig(store, base, {
        completions: [
          { pattern: "^specific$", content: "Specific response" },
        ],
      });

      const res = await app.request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "something else entirely" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.choices[0].message.content).toBe("This is a mock response from the emulated OpenAI API.");
    });
  });

  describe("POST /v1/chat/completions (streaming)", () => {
    it("returns SSE stream with correct wire format", async () => {
      const res = await app.request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

      const text = await res.text();
      const events = text.split("\n\n").filter((e) => e.trim().length > 0);

      const dataEvents = events
        .map((e) => {
          const match = e.match(/^data:\s*(.+)$/m);
          return match ? match[1] : null;
        })
        .filter(Boolean) as string[];

      expect(dataEvents.length).toBeGreaterThan(2);

      const firstChunk = JSON.parse(dataEvents[0]);
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(firstChunk.choices[0].delta.role).toBe("assistant");

      const lastJsonIdx = dataEvents.findIndex((d) => d === "[DONE]");
      expect(lastJsonIdx).toBeGreaterThan(0);

      const beforeDone = JSON.parse(dataEvents[lastJsonIdx - 1]);
      expect(beforeDone.choices[0].finish_reason).toBe("stop");

      const contentChunks = dataEvents.slice(1, lastJsonIdx - 1);
      for (const chunk of contentChunks) {
        const parsed = JSON.parse(chunk);
        expect(parsed.choices[0].delta.content).toBeDefined();
      }
    });
  });

  describe("POST /v1/chat/completions (tool calls)", () => {
    it("returns tool calls when matched config has them", async () => {
      seedFromConfig(store, base, {
        completions: [
          {
            pattern: "weather",
            content: "",
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"San Francisco"}',
                },
              },
            ],
          },
          { pattern: ".*", content: "Default response" },
        ],
      });

      const res = await app.request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "What is the weather?" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
      expect(body.choices[0].message.content).toBeNull();
    });
  });

  describe("POST /v1/embeddings", () => {
    it("returns deterministic embeddings", async () => {
      const res1 = await app.request(`${base}/v1/embeddings`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "text-embedding-ada-002",
          input: "test input",
        }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json() as any;
      expect(body1.object).toBe("list");
      expect(body1.data).toHaveLength(1);
      expect(body1.data[0].embedding).toHaveLength(1536);
      expect(body1.data[0].object).toBe("embedding");
      expect(body1.usage.prompt_tokens).toBeGreaterThan(0);

      const res2 = await app.request(`${base}/v1/embeddings`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "text-embedding-ada-002",
          input: "test input",
        }),
      });
      const body2 = await res2.json() as any;
      expect(body2.data[0].embedding).toEqual(body1.data[0].embedding);
    });
  });

  describe("GET /v1/models", () => {
    it("returns seeded models", async () => {
      const res = await app.request(`${base}/v1/models`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.object).toBe("list");
      expect(body.data.length).toBeGreaterThanOrEqual(5);
      const ids = body.data.map((m: any) => m.id);
      expect(ids).toContain("gpt-4o");
      expect(ids).toContain("text-embedding-ada-002");
    });
  });

  describe("GET /v1/models/:id", () => {
    it("returns a specific model", async () => {
      const res = await app.request(`${base}/v1/models/gpt-4o`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe("gpt-4o");
      expect(body.object).toBe("model");
      expect(body.owned_by).toBe("openai");
    });

    it("returns 404 for unknown model", async () => {
      const res = await app.request(`${base}/v1/models/gpt-5`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("model_not_found");
      expect(body.error.message).toContain("gpt-5");
    });
  });

  describe("GET /playground", () => {
    it("renders the playground page", async () => {
      const res = await app.request(`${base}/playground`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Playground");
      expect(html).toContain("OpenAI");
      expect(html.length).toBeGreaterThan(0);
    });
  });
});
