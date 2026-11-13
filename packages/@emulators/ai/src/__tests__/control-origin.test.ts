import { createServer } from "@emulators/core";
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
