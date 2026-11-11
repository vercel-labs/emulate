import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware } from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { createSlackTestApp, slackTestBaseUrl, slackTestToken, type SlackTestHttpApp } from "./helpers.js";
import { seedFromConfig, slackPlugin } from "../index.js";

function form(body: Record<string, string>) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  };
}

function authTest(app: SlackTestHttpApp, token: string) {
  return app.request(`${slackTestBaseUrl}/api/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function revoke(app: SlackTestHttpApp, token: string, body: Record<string, string> = {}) {
  return app.request(`${slackTestBaseUrl}/api/auth.revoke`, {
    ...form(body),
    headers: { Authorization: `Bearer ${token}`, ...form(body).headers },
  });
}

describe("Slack auth.revoke", () => {
  it("revokes the calling token", async () => {
    const { app } = createSlackTestApp();
    expect(((await (await authTest(app, slackTestToken)).json()) as { ok: boolean }).ok).toBe(true);

    expect(await (await revoke(app, slackTestToken)).json()).toEqual({ ok: true, revoked: true });
    expect(await (await authTest(app, slackTestToken)).json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("does not revoke anything with test=1", async () => {
    const { app } = createSlackTestApp();
    expect(await (await revoke(app, slackTestToken, { test: "1" })).json()).toEqual({ ok: true, revoked: false });
    expect(((await (await authTest(app, slackTestToken)).json()) as { ok: boolean }).ok).toBe(true);
  });

  it("accepts the token as a request argument", async () => {
    const { app } = createSlackTestApp();
    const res = await app.request(`${slackTestBaseUrl}/api/auth.revoke`, form({ token: slackTestToken }));
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(await (await authTest(app, slackTestToken)).json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("rejects a token that was never issued and one that was already revoked", async () => {
    const { app } = createSlackTestApp();
    expect(await (await revoke(app, "xoxb-never-issued")).json()).toEqual({ ok: false, error: "invalid_auth" });
    await revoke(app, slackTestToken);
    expect(await (await revoke(app, slackTestToken)).json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("requires a token", async () => {
    const { app } = createSlackTestApp();
    const res = await app.request(`${slackTestBaseUrl}/api/auth.revoke`, form({}));
    expect(await res.json()).toEqual({ ok: false, error: "not_authed" });
  });

  it("keeps the revoked token invalid when unknown tokens fall back to a user", async () => {
    const store = new Store();
    const tokenMap: TokenMap = new Map([[slackTestToken, { login: "U000000001", id: 1, scopes: [] }]]);
    const app = new Hono();
    app.use("*", authMiddleware(tokenMap, undefined, { login: "U000000001", id: 1, scopes: [] }));
    slackPlugin.register(app as any, store, new WebhookDispatcher(), slackTestBaseUrl, tokenMap);
    slackPlugin.seed?.(store, slackTestBaseUrl);
    seedFromConfig(store, slackTestBaseUrl, { tokens: [{ token: slackTestToken, user_id: "U000000001" }] });

    expect(((await (await authTest(app, slackTestToken)).json()) as { ok: boolean }).ok).toBe(true);
    await revoke(app, slackTestToken);
    expect(await (await authTest(app, slackTestToken)).json()).toEqual({ ok: false, error: "invalid_auth" });
  });
});
