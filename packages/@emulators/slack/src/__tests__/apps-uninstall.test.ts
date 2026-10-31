import { createHmac } from "node:crypto";
import { createServer } from "@emulators/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig, slackPlugin } from "../index.js";
import {
  captureFetchRequests,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  slackTestToken,
  type SlackTestApp,
} from "./helpers.js";

const clientId = "uninstall-client";
const clientSecret = "uninstall-secret";
const appId = "A_UNINSTALL";
const botUserId = "U_UNINSTALL_BOT";
const credentials = { client_id: clientId, client_secret: clientSecret };

function setupApp(fallback = false) {
  const setup = createServer(slackPlugin, {
    baseUrl: base,
    tokens: { [slackTestToken]: { login: "U000000001", id: 1 } },
    ...(fallback ? { fallbackUser: { login: "U000000001", id: 1, scopes: [] } } : {}),
  });
  slackPlugin.seed?.(setup.store, base);
  seedFromConfig(setup.store, base, {
    users: [{ name: "alice" }],
    oauth_apps: [
      {
        ...credentials,
        app_id: appId,
        name: "Uninstall App",
        bot_user_id: botUserId,
        redirect_uris: ["https://example.com/callback"],
      },
      {
        client_id: "other-client",
        client_secret: "other-secret",
        app_id: "A_OTHER",
        name: "Other App",
        redirect_uris: ["https://example.com/callback"],
      },
    ],
  });
  return setup;
}

async function api(
  setup: SlackTestApp,
  method: string,
  body: Record<string, unknown> = {},
  token: string | null = slackTestToken,
) {
  const response = await setup.app.request(`${base}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

async function install(setup: SlackTestApp, userId = "U000000001", otherApp = false) {
  const appCredentials = otherApp ? { client_id: "other-client", client_secret: "other-secret" } : credentials;
  const response = await setup.app.request(`${base}/oauth/v2/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_id: userId,
      client_id: appCredentials.client_id,
      redirect_uri: "https://example.com/callback",
      scope: "chat:write",
      user_scope: "chat:write",
    }),
  });
  expect(response.status).toBe(302);
  const code = new URL(response.headers.get("Location")!).searchParams.get("code");
  const exchanged = await api(
    setup,
    "oauth.v2.access",
    { ...appCredentials, code, redirect_uri: "https://example.com/callback" },
    null,
  );
  expect(exchanged.ok).toBe(true);
  return { bot: exchanged.access_token as string, user: exchanged.authed_user.access_token as string };
}

describe("Slack app uninstall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("revokes every grant for one installation before delivering signed lifecycle events", async () => {
    const setup = setupApp(true);
    seedFromConfig(setup.store, base, { signing_secret: "uninstall-signing-secret" });
    const ss = getSlackStore(setup.store);
    const alice = ss.users.findOneBy("name", "alice")!;
    const first = await install(setup);
    const second = await install(setup, alice.user_id);
    const other = await install(setup, "U000000001", true);
    const tokens = [first.bot, first.user, second.bot, second.user];
    const bodies: Array<Record<string, any>> = [];
    registerSlackEventSubscription(setup.webhooks, ["app_uninstalled", "tokens_revoked"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        expect(ss.installations.findOneBy("app_id", appId)).toBeUndefined();
        expect(ss.tokens.findBy("app_id", appId)).toHaveLength(0);
        for (const token of tokens) {
          expect(setup.tokenMap.has(token)).toBe(false);
          expect(await api(setup, "chat.postMessage", { channel: "general", text: "Old token" }, token)).toEqual({
            ok: false,
            error: "token_revoked",
          });
        }
        const body = String(init.body);
        const headers = init.headers as Record<string, string>;
        expect(headers["X-Slack-Signature"]).toBe(
          `v0=${createHmac("sha256", "uninstall-signing-secret").update(`v0:${headers["X-Slack-Request-Timestamp"]}:${body}`).digest("hex")}`,
        );
        expect(tokens.some((token) => body.includes(token))).toBe(false);
        bodies.push(JSON.parse(body));
        return { ok: true, status: 200 };
      }),
    );

    expect(await api(setup, "apps.uninstall", credentials, first.user)).toEqual({ ok: true });
    expect(bodies.map((body) => body.event.type).sort()).toEqual(["app_uninstalled", "tokens_revoked"]);
    for (const body of bodies) {
      expect(body).toMatchObject({
        api_app_id: appId,
        team_id: "T000000001",
        event_id: expect.any(String),
        authorizations: [expect.objectContaining({ user_id: botUserId, is_bot: true })],
      });
    }
    expect(bodies.find((body) => body.event.type === "tokens_revoked")!.event.tokens).toEqual({
      oauth: ["U000000001", alice.user_id],
      bot: [botUserId],
    });
    expect(ss.oauthApps.findOneBy("client_id", clientId)).toBeDefined();
    expect((await api(setup, "auth.test", {}, other.bot)).ok).toBe(true);
    expect((await api(setup, "auth.test", {}, other.user)).ok).toBe(true);
    expect((await api(setup, "auth.test")).ok).toBe(true);
    expect(await api(setup, "apps.uninstall", credentials, first.user)).toEqual({ ok: false, error: "token_revoked" });
    expect(bodies).toHaveLength(2);
  });

  it.each(["missing token", "unknown token", "unknown client", "bad secret", "another app", "bot token"])(
    "rejects %s without changing installation state",
    async (kind) => {
      const setup = setupApp();
      const tokens = await install(setup);
      const other = await install(setup, "U000000001", true);
      const capture = captureFetchRequests();
      registerSlackEventSubscription(setup.webhooks);
      const before = JSON.stringify(setup.store.snapshot());
      const body =
        kind === "unknown client"
          ? { ...credentials, client_id: "unknown" }
          : kind === "bad secret"
            ? { ...credentials, client_secret: "incorrect" }
            : credentials;
      const token =
        kind === "missing token"
          ? null
          : kind === "unknown token"
            ? "unknown"
            : kind === "another app"
              ? other.user
              : kind === "bot token"
                ? tokens.bot
                : tokens.user;
      const error = (
        {
          "missing token": "not_authed",
          "unknown token": "invalid_auth",
          "unknown client": "invalid_client_id",
          "bad secret": "bad_client_secret",
          "another app": "client_id_token_mismatch",
          "bot token": "no_permission",
        } as Record<string, string>
      )[kind];
      expect(await api(setup, "apps.uninstall", body, token)).toEqual({ ok: false, error });
      expect(JSON.stringify(setup.store.snapshot())).toBe(before);
      expect(capture.requests).toHaveLength(0);
    },
  );

  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "accepts a user token in a %s POST body",
    async (contentType) => {
      const setup = setupApp();
      const tokens = await install(setup);
      const body = { ...credentials, token: tokens.user };
      const response = await setup.app.request(`${base}/api/apps.uninstall`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: contentType === "application/json" ? JSON.stringify(body) : new URLSearchParams(body),
      });
      expect(await response.json()).toEqual({ ok: true });
      expect(await api(setup, "apps.uninstall", body, null)).toEqual({ ok: false, error: "token_revoked" });
      expect(await api(setup, "auth.test", {}, tokens.bot)).toEqual({ ok: false, error: "token_revoked" });
    },
  );

  it("gives the header token precedence over a conflicting body token", async () => {
    const setup = setupApp();
    const target = await install(setup);
    const other = await install(setup, "U000000001", true);
    expect(await api(setup, "apps.uninstall", { ...credentials, token: target.user }, other.user)).toEqual({
      ok: false,
      error: "client_id_token_mismatch",
    });
    expect(getSlackStore(setup.store).installations.findOneBy("app_id", appId)).toBeDefined();
  });

  it("keeps the same app's installation and credentials in another workspace", async () => {
    const setup = setupApp();
    const tokens = await install(setup);
    const ss = getSlackStore(setup.store);
    ss.installations.insert({
      installation_id: "I_OTHER_TEAM",
      app_id: appId,
      client_id: clientId,
      team_id: "T_OTHER",
      app_name: "Uninstall App",
      installer_user_id: "U000000001",
      bot_id: "B_OTHER_TEAM",
      bot_user_id: "U_OTHER_BOT",
      scopes: [],
      user_scopes: [],
    });
    seedFromConfig(setup.store, base, {
      tokens: [
        {
          token: "xoxp-other-team",
          type: "user",
          user_id: "U000000001",
          app_id: appId,
          client_id: clientId,
          team_id: "T_OTHER",
        },
      ],
    });
    expect(await api(setup, "apps.uninstall", credentials, tokens.user)).toEqual({ ok: true });
    expect(ss.installations.findOneBy("installation_id", "I_OTHER_TEAM")).toBeDefined();
    expect(ss.tokens.findOneBy("token", "xoxp-other-team")).toBeDefined();
    expect((await api(setup, "auth.test", {}, "xoxp-other-team")).ok).toBe(true);
  });

  it("rejects a request when the app has no installation in the token's workspace", async () => {
    const setup = setupApp();
    seedFromConfig(setup.store, base, {
      tokens: [
        { token: "xoxp-uninstalled-team", type: "user", user_id: "U000000001", team_id: "T_OTHER", app_id: appId },
      ],
    });
    expect(await api(setup, "apps.uninstall", credentials, "xoxp-uninstalled-team")).toEqual({
      ok: false,
      error: "client_id_token_mismatch",
    });
    expect(getSlackStore(setup.store).installations.findOneBy("app_id", appId)).toBeDefined();
  });

  it("supports development tokens and seeded credentials without requiring a method scope", async () => {
    const setup = setupApp();
    seedFromConfig(setup.store, base, {
      strict_scopes: true,
      tokens: [
        { token: "seeded-user", type: "user", user_id: "U000000001", client_id: clientId, scopes: [] },
        { token: "seeded-bot", type: "bot", user_id: botUserId, app_id: appId, scopes: [] },
      ],
    });
    expect(await api(setup, "apps.uninstall", credentials)).toEqual({ ok: true });
    for (const token of ["seeded-user", "seeded-bot"]) {
      expect(await api(setup, "auth.test", {}, token)).toEqual({ ok: false, error: "token_revoked" });
    }
    expect((await api(setup, "auth.test")).ok).toBe(true);
  });

  it("remembers revoked credentials across snapshots even with a stale shared auth entry", async () => {
    const setup = setupApp(true);
    const tokens = await install(setup);
    await api(setup, "apps.uninstall", credentials, tokens.user);
    const restored = setupApp(true);
    restored.store.restore(JSON.parse(JSON.stringify(setup.store.snapshot())));
    restored.tokenMap.set(tokens.bot, { login: botUserId, id: 1, scopes: ["chat:write"] });
    expect(await api(restored, "auth.test", {}, tokens.bot)).toEqual({ ok: false, error: "token_revoked" });
    expect(await api(restored, "chat.postMessage", { channel: "general", text: "Revoked" }, tokens.user)).toEqual({
      ok: false,
      error: "token_revoked",
    });
    expect((await api(restored, "auth.test", {}, "new-development-token")).ok).toBe(true);
  });

  it("can reinstall the app without reactivating its old tokens", async () => {
    const setup = setupApp(true);
    const old = await install(setup);
    await api(setup, "apps.uninstall", credentials, old.user);
    const fresh = await install(setup);
    expect(getSlackStore(setup.store).installations.findOneBy("app_id", appId)).toBeDefined();
    expect((await api(setup, "auth.test", {}, fresh.bot)).ok).toBe(true);
    expect((await api(setup, "auth.test", {}, fresh.user)).ok).toBe(true);
    expect(await api(setup, "auth.test", {}, old.bot)).toEqual({ ok: false, error: "token_revoked" });
    expect(await api(setup, "auth.test", {}, old.user)).toEqual({ ok: false, error: "token_revoked" });
  });

  it("supports the permissive OAuth flow when no app definitions are configured", async () => {
    const setup = setupApp();
    const ss = getSlackStore(setup.store);
    for (const app of ss.oauthApps.all()) ss.oauthApps.delete(app.id);
    for (const installation of ss.installations.all()) ss.installations.delete(installation.id);
    const tokens = await install(setup);
    expect(await api(setup, "apps.uninstall", credentials, tokens.user)).toEqual({ ok: true });
    expect(ss.installations.all()).toHaveLength(0);
    expect(await api(setup, "auth.test", {}, tokens.bot)).toEqual({ ok: false, error: "token_revoked" });
  });

  it("completes cleanup when an event receiver returns an error", async () => {
    const setup = setupApp();
    const tokens = await install(setup);
    const capture = captureFetchRequests(500);
    registerSlackEventSubscription(setup.webhooks, ["app_uninstalled", "tokens_revoked"]);
    expect(await api(setup, "apps.uninstall", credentials, tokens.user)).toEqual({ ok: true });
    expect(capture.requests).toHaveLength(2);
    expect(getSlackStore(setup.store).installations.findOneBy("app_id", appId)).toBeUndefined();
    expect(await api(setup, "auth.test", {}, tokens.bot)).toEqual({ ok: false, error: "token_revoked" });
  });
});
