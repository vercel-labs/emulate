import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { aiPlugin } from "../index.js";

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
