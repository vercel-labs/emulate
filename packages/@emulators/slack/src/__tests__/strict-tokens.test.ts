import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { seedFromConfig, slackPlugin } from "../index.js";

const base = "http://localhost:4000";
const knownToken = "xoxb-known-token";
const fallback = { login: "U000000001", id: 1, scopes: ["chat:write", "channels:read"] };

function createTestApp(strict: boolean, fallbackUser = true) {
  const store = new Store();
  const tokenMap: TokenMap = new Map([[knownToken, { login: "U000000001", id: 1, scopes: ["chat:write"] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap, undefined, fallbackUser ? fallback : undefined));
  slackPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  slackPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    strict_scopes: strict,
    tokens: [{ token: knownToken, user_id: "U000000001", scopes: ["chat:write"] }],
  });
  return { app, store, tokenMap };
}

function authTest(app: Hono<any>, token: string) {
  return app.request(`${base}/api/auth.test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

describe("Slack strict mode tokens", () => {
  it("rejects a token the emulator never issued instead of using the fallback user", async () => {
    const { app } = createTestApp(true);
    const res = await authTest(app, "xoxb-never-issued");
    expect(await res.json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("accepts a seeded token", async () => {
    const { app } = createTestApp(true);
    const res = await authTest(app, knownToken);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("keeps the fallback user for unknown tokens by default", async () => {
    const { app } = createTestApp(false);
    const res = await authTest(app, "xoxb-never-issued");
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("does not treat OAuth access exchange credentials as a Slack token", async () => {
    const { app } = createTestApp(true);
    const res = await app.request(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
      },
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe("invalid_auth");
  });

  it("still answers token_revoked for a revoked token", async () => {
    const { app, store } = createTestApp(true);
    store.setData("slack.revoked_tokens", new Set([knownToken]));
    expect(await (await authTest(app, knownToken)).json()).toEqual({ ok: false, error: "token_revoked" });
  });
});
