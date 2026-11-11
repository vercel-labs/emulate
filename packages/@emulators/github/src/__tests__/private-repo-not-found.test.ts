import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map([
    ["owner-token", { login: "owner", id: 1, scopes: ["repo"] }],
    ["outsider-token", { login: "outsider", id: 2, scopes: ["repo"] }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "owner" }, { login: "outsider" }],
    repos: [{ owner: "owner", name: "secret", private: true, auto_init: true }],
  });
  return app;
}

function request(app: Hono<any>, path: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : {};
  return app.request(`${base}${path}`, { ...init, headers });
}

describe("GitHub private repositories", () => {
  it("answers 404 to callers who cannot see a private repository", async () => {
    const app = createTestApp();
    expect((await request(app, "/repos/owner/secret", "owner-token")).status).toBe(200);
    expect((await request(app, "/repos/owner/secret", "outsider-token")).status).toBe(404);
    expect((await request(app, "/repos/owner/secret")).status).toBe(404);
    expect((await request(app, "/repos/owner/secret/contents/README.md", "outsider-token")).status).toBe(404);
  });

  it("answers 404 to a write on a private repository the caller cannot see", async () => {
    const res = await request(createTestApp(), "/repos/owner/secret/issues", "outsider-token", {
      method: "POST",
      body: JSON.stringify({ title: "hidden" }),
    });
    expect(res.status).toBe(404);
  });
});
