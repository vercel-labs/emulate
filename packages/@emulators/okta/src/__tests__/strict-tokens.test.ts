import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(strict: boolean) {
  const store = new Store();
  const tokenMap: TokenMap = new Map([["ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap, undefined, { login: "admin@okta.local", id: 1, scopes: [] }));
  oktaPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, { strict_scopes: strict });
  return { app, tokenMap };
}

function listUsers(app: Hono<any>, authorization: string) {
  return app.request(`${base}/api/v1/users`, { headers: { Authorization: authorization } });
}

describe("Okta strict mode management tokens", () => {
  it("rejects an API token the emulator never issued", async () => {
    const { app } = createTestApp(true);
    const res = await listUsers(app, "SSWS never-issued");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("E0000011");
  });

  it("accepts a known API token and a known bearer token", async () => {
    const { app, tokenMap } = createTestApp(true);
    expect((await listUsers(app, "SSWS ssws-token")).status).toBe(200);
    tokenMap.set("access-token", { login: "admin@okta.local", id: 1, scopes: ["okta.users.read"] });
    expect((await listUsers(app, "Bearer access-token")).status).toBe(200);
  });

  it("rejects a bearer token once it is removed from the token map", async () => {
    const { app, tokenMap } = createTestApp(true);
    tokenMap.set("access-token", { login: "admin@okta.local", id: 1, scopes: ["okta.users.read"] });
    tokenMap.delete("access-token");
    expect((await listUsers(app, "Bearer access-token")).status).toBe(401);
  });

  it("keeps the fallback user for unknown tokens by default", async () => {
    const { app } = createTestApp(false);
    expect((await listUsers(app, "SSWS never-issued")).status).toBe(200);
  });
});
