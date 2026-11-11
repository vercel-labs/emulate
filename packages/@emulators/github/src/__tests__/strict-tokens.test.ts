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

function createTestApp(strict: boolean) {
  const store = new Store();
  const tokenMap: TokenMap = new Map([["alice-token", { login: "alice", id: 2, scopes: ["repo", "user"] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap, undefined, { login: "admin", id: 1, scopes: ["repo", "user", "admin:org"] }));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, { users: [{ login: "admin" }, { login: "alice" }], strict_scopes: strict });
  return { app, tokenMap };
}

function getUser(app: Hono<any>, token: string) {
  return app.request(`${base}/user`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("GitHub strict mode tokens", () => {
  it("rejects a token the emulator never issued", async () => {
    const { app } = createTestApp(true);
    const res = await getUser(app, "ghp_never_issued");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toBe("Bad credentials");
  });

  it("rejects a token once it is removed from the token map", async () => {
    const { app, tokenMap } = createTestApp(true);
    expect(((await (await getUser(app, "alice-token")).json()) as { login: string }).login).toBe("alice");
    tokenMap.delete("alice-token");
    expect((await getUser(app, "alice-token")).status).toBe(401);
  });

  it("keeps the fallback user for unknown tokens by default", async () => {
    const { app } = createTestApp(false);
    const res = await getUser(app, "ghp_never_issued");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe("admin");
  });
});
