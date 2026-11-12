import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware } from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl,
  slackTestToken,
  type SlackTestApp,
  type SlackTestHttpApp,
} from "./helpers.js";
import { getSlackStore, seedFromConfig, slackPlugin } from "../index.js";

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

  it.each(["1", "true", "True"])("does not revoke anything with test=%s", async (test) => {
    const { app } = createSlackTestApp();
    expect(await (await revoke(app, slackTestToken, { test })).json()).toEqual({ ok: true, revoked: false });
    expect(((await (await authTest(app, slackTestToken)).json()) as { ok: boolean }).ok).toBe(true);
  });

  it.each([1, true, "1"])("does not revoke anything with a JSON test value of %j", async (test) => {
    const { app } = createSlackTestApp();
    const res = await app.request(`${slackTestBaseUrl}/api/auth.revoke`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ test }),
    });
    expect(await res.json()).toEqual({ ok: true, revoked: false });
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

describe("Slack auth.revoke with a bot token", () => {
  const botUserId = "U_REVOKE_BOT";
  const botId = "B_REVOKE_BOT";
  const appId = "A_REVOKE";
  const credentials = { client_id: "revoke-client", client_secret: "revoke-secret" };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setupBotApp() {
    const setup = createSlackTestApp();
    seedFromConfig(setup.store, slackTestBaseUrl, {
      channels: [{ name: "bot-room" }],
      oauth_apps: [
        {
          ...credentials,
          app_id: appId,
          name: "Revoke Bot",
          bot_id: botId,
          bot_user_id: botUserId,
          redirect_uris: ["https://example.com/callback"],
          scopes: ["app_mentions:read", "chat:write"],
        },
      ],
    });
    return setup;
  }

  async function call(setup: SlackTestApp, method: string, body: Record<string, unknown>) {
    const res = await setup.app.request(`${slackTestBaseUrl}/api/${method}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, any>;
  }

  async function install(setup: SlackTestApp, userScope = "") {
    const callback = await setup.app.request(`${slackTestBaseUrl}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: "U000000001",
        client_id: credentials.client_id,
        redirect_uri: "https://example.com/callback",
        scope: "app_mentions:read,chat:write",
        ...(userScope ? { user_scope: userScope } : {}),
      }),
    });
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const res = await setup.app.request(
      `${slackTestBaseUrl}/api/oauth.v2.access`,
      form({ ...credentials, code, redirect_uri: "https://example.com/callback" }),
    );
    const body = (await res.json()) as { ok: boolean; access_token: string; authed_user: { access_token?: string } };
    expect(body.ok).toBe(true);
    return { bot: body.access_token, user: body.authed_user.access_token };
  }

  it("deactivates the bot user and removes its channel memberships without uninstalling the app", async () => {
    const setup = setupBotApp();
    const ss = getSlackStore(setup.store);
    const { bot } = await install(setup);
    const channel = ss.channels.findOneBy("name", "bot-room")!.channel_id;
    expect((await call(setup, "conversations.invite", { channel, users: botUserId })).ok).toBe(true);
    const membersBefore = ss.channels.findOneBy("channel_id", channel)!.num_members;

    expect(await (await revoke(setup.app, bot)).json()).toEqual({ ok: true, revoked: true });

    const room = ss.channels.findOneBy("channel_id", channel)!;
    expect(room.members).not.toContain(botUserId);
    expect(room.num_members).toBe(membersBefore - 1);
    expect(ss.users.findOneBy("user_id", botUserId)!.deleted).toBe(true);
    expect(ss.bots.findOneBy("bot_id", botId)!.deleted).toBe(true);
    expect(ss.installations.findOneBy("app_id", appId)).toBeDefined();
    expect((await call(setup, "bots.info", { bot: botId })).bot).toMatchObject({ id: botId, deleted: true });
  });

  it("stops app_mention callbacks for the revoked bot", async () => {
    const setup = setupBotApp();
    const { bot } = await install(setup);
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "bot-room")!.channel_id;
    await call(setup, "conversations.invite", { channel, users: botUserId });
    await revoke(setup.app, bot);

    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);
    expect((await call(setup, "chat.postMessage", { channel, text: `<@${botUserId}> are you there?` })).ok).toBe(true);
    expect(capture.requests).toHaveLength(0);
  });

  it("leaves the bot user active when a user token is revoked", async () => {
    const setup = setupBotApp();
    const ss = getSlackStore(setup.store);
    const { user } = await install(setup, "chat:write");
    const channel = ss.channels.findOneBy("name", "bot-room")!.channel_id;
    await call(setup, "conversations.invite", { channel, users: botUserId });

    expect(await (await revoke(setup.app, user!)).json()).toEqual({ ok: true, revoked: true });
    expect(ss.users.findOneBy("user_id", botUserId)!.deleted).toBe(false);
    expect(ss.bots.findOneBy("bot_id", botId)!.deleted).toBe(false);
    expect(ss.channels.findOneBy("channel_id", channel)!.members).toContain(botUserId);
  });

  it("keeps the bot user active while a newer bot token from a reinstall is still valid", async () => {
    const setup = setupBotApp();
    const ss = getSlackStore(setup.store);
    const { bot: oldToken } = await install(setup);
    const channel = ss.channels.findOneBy("name", "bot-room")!.channel_id;
    expect((await call(setup, "conversations.invite", { channel, users: botUserId })).ok).toBe(true);
    const { bot: newToken } = await install(setup);

    expect(await (await revoke(setup.app, oldToken)).json()).toEqual({ ok: true, revoked: true });
    expect(await (await authTest(setup.app, oldToken)).json()).toEqual({ ok: false, error: "invalid_auth" });
    expect(await (await authTest(setup.app, newToken)).json()).toMatchObject({ ok: true, user_id: botUserId });
    expect(ss.users.findOneBy("user_id", botUserId)!.deleted).toBe(false);
    expect(ss.bots.findOneBy("bot_id", botId)!.deleted).toBe(false);
    expect(ss.channels.findOneBy("channel_id", channel)!.members).toContain(botUserId);

    expect(await (await revoke(setup.app, newToken)).json()).toEqual({ ok: true, revoked: true });
    expect(ss.users.findOneBy("user_id", botUserId)!.deleted).toBe(true);
    expect(ss.bots.findOneBy("bot_id", botId)!.deleted).toBe(true);
    expect(ss.channels.findOneBy("channel_id", channel)!.members).not.toContain(botUserId);
  });

  it("reactivates the bot user when the app is installed again", async () => {
    const setup = setupBotApp();
    const ss = getSlackStore(setup.store);
    await revoke(setup.app, (await install(setup)).bot);

    const { bot } = await install(setup);
    expect(ss.users.findOneBy("user_id", botUserId)!.deleted).toBe(false);
    expect(ss.bots.findOneBy("bot_id", botId)!.deleted).toBe(false);
    const res = await authTest(setup.app, bot);
    expect(await res.json()).toMatchObject({ ok: true, user_id: botUserId, bot_id: botId });
  });
});
