import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, type AppEnv, type TokenMap } from "@emulators/core";
import { facebookPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4007";
const callback = "http://localhost:3000/callback";
const appId = "app-1";
const appSecret = "secret-1";

function setup() {
  const store = new Store();
  const app = new Hono<AppEnv>();
  const tokenMap: TokenMap = new Map();
  facebookPlugin.register(app, store, new WebhookDispatcher(), base, tokenMap);
  facebookPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { id: "user-1", name: "Owner", email: "owner@example.com" },
      { id: "user-2", name: "Other", email: "other@example.com" },
    ],
    oauth_apps: [{ app_id: appId, app_secret: appSecret, name: "Test App", redirect_uris: [callback] }],
    pages: [
      { id: "page-1", name: "Owner Page", owner_user_ids: ["user-1"] },
      { id: "page-2", name: "Other Page", owner_user_ids: ["user-2"] },
    ],
    page_videos: [
      { id: "video-1", page_id: "page-1", title: "Metrics", views: 42, likes: 7, comments: 3 },
      { id: "video-2", page_id: "page-2", title: "Private", views: 99 },
    ],
  });
  return { app, store, tokenMap };
}

async function authorize(
  app: Hono<AppEnv>,
  userId = "user-1",
  scope = "public_profile,pages_show_list,pages_read_engagement",
) {
  const authorizeQuery = new URLSearchParams({
    client_id: appId,
    redirect_uri: callback,
    response_type: "code",
    scope,
    state: "state-123",
  });
  const authorizeResponse = await app.request(base + "/dialog/oauth?" + authorizeQuery);
  const html = await authorizeResponse.text();
  const transactionId = html.match(/name="transaction_id" value="([^"]+)"/)?.[1] ?? "";
  const form = new URLSearchParams({
    user_id: userId,
    transaction_id: transactionId,
  });
  const response = await app.request(base + "/dialog/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const location = new URL(response.headers.get("location") ?? "");
  return { response, code: location.searchParams.get("code") ?? "", state: location.searchParams.get("state") };
}

async function exchange(app: Hono<AppEnv>, code: string, secret = appSecret, redirectUri = callback) {
  const query = new URLSearchParams({
    client_id: appId,
    client_secret: secret,
    redirect_uri: redirectUri,
    code,
  });
  return app.request(base + "/v23.0/oauth/access_token?" + query);
}

async function userToken(app: Hono<AppEnv>, userId = "user-1", scope?: string) {
  const auth = await authorize(app, userId, scope);
  const response = await exchange(app, auth.code);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

describe("Facebook emulator", () => {
  let app: Hono<AppEnv>;
  let store: Store;
  let tokenMap: TokenMap;

  beforeEach(() => {
    ({ app, store, tokenMap } = setup());
  });

  it("resolves a shared bearer token by configured user ID and preserves its scopes", async () => {
    tokenMap.set("configured-token", {
      login: "user-2",
      id: 1,
      scopes: ["public_profile"],
    });
    const response = await app.request(base + "/me?fields=id,name,email", {
      headers: { authorization: "Bearer configured-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "user-2",
      name: "Other",
    });

    const accounts = await app.request(base + "/me/accounts?access_token=configured-token");
    expect(accounts.status).toBe(403);
  });

  it("does not silently authenticate an unmatched shared token as the first user", async () => {
    tokenMap.set("unmatched-token", {
      login: "missing-user",
      id: 1,
      scopes: ["public_profile", "email"],
    });
    const response = await app.request(base + "/me?access_token=unmatched-token");
    expect(response.status).toBe(401);
  });

  it("continues to resolve privately issued tokens", async () => {
    const token = await userToken(app, "user-1", "public_profile,email");
    tokenMap.clear();
    const response = await app.request(base + "/me?fields=id,name,email&access_token=" + token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-1", name: "Owner", email: "owner@example.com" });
  });

  it("rejects an unknown token when the shared token map is empty", async () => {
    tokenMap.clear();
    const response = await app.request(base + "/me?access_token=unknown");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(190);
  });

  it("renders shared OAuth UI through versioned and unversioned endpoints", async () => {
    for (const path of ["/dialog/oauth", "/v23.0/dialog/oauth"]) {
      const query = new URLSearchParams({ client_id: appId, redirect_uri: callback, response_type: "code" });
      const response = await app.request(base + path + "?" + query);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Log in with Facebook");
    }
  });

  it("passes state through and exchanges a code once", async () => {
    const auth = await authorize(app);
    expect(auth.response.status).toBe(302);
    expect(auth.state).toBe("state-123");
    const first = await exchange(app, auth.code);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { access_token: string }).access_token).toMatch(/^EAA/);
    const second = await exchange(app, auth.code);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: { code: number } }).error.code).toBe(100);
  });

  it("exchanges a short-lived token for a long-lived one via fb_exchange_token", async () => {
    const shortLived = await userToken(app);
    const query = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLived,
    });
    const response = await app.request(base + "/oauth/access_token?" + query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(body.access_token).toMatch(/^EAA/);
    expect(body.access_token).not.toBe(shortLived);
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(5184000);
    const me = await app.request(base + "/me?access_token=" + body.access_token);
    expect(await me.json()).toEqual({ id: "user-1", name: "Owner" });
  });

  it("rejects fb_exchange_token with wrong app credentials", async () => {
    const shortLived = await userToken(app);
    const query = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: "wrong",
      fb_exchange_token: shortLived,
    });
    const response = await app.request(base + "/oauth/access_token?" + query);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(101);
  });

  it("rejects fb_exchange_token for a token issued to another app", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [{ app_id: "app-2", app_secret: "secret-2", name: "Other App", redirect_uris: [callback] }],
    });
    const shortLived = await userToken(app);
    const query = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: "app-2",
      client_secret: "secret-2",
      fb_exchange_token: shortLived,
    });
    const response = await app.request(base + "/oauth/access_token?" + query);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(190);
  });

  it("returns a clear error for an unknown grant_type instead of the code error", async () => {
    const query = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appSecret,
    });
    const response = await app.request(base + "/oauth/access_token?" + query);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(100);
    expect(body.error.message).toContain("Unsupported grant_type");
    expect(body.error.message).not.toContain("authorization code");
  });

  it("rejects invalid clients, secrets, redirects, and codes", async () => {
    const invalidClient = await app.request(
      base + "/dialog/oauth?client_id=missing&redirect_uri=" + encodeURIComponent(callback),
    );
    expect(invalidClient.status).toBe(400);
    const invalidRedirect = await app.request(
      base + "/dialog/oauth?client_id=" + appId + "&redirect_uri=http%3A%2F%2Fevil.test",
    );
    expect(invalidRedirect.status).toBe(400);
    const auth = await authorize(app);
    expect((await exchange(app, auth.code, "wrong")).status).toBe(400);
    expect((await exchange(app, auth.code, appSecret, "http://evil.test")).status).toBe(400);
    expect((await exchange(app, "missing")).status).toBe(400);
  });

  it("rejects forged callbacks and ignores altered callback inputs", async () => {
    const forged = await app.request(base + "/dialog/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: "user-1",
        client_id: appId,
        redirect_uri: callback,
        scope: "public_profile",
        state: "forged",
      }),
    });
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();

    const query = new URLSearchParams({
      client_id: appId,
      redirect_uri: callback,
      response_type: "code",
      scope: "public_profile",
      state: "original",
    });
    const page = await app.request(base + "/dialog/oauth?" + query);
    const transactionId = (await page.text()).match(/name="transaction_id" value="([^"]+)"/)?.[1] ?? "";
    const altered = await app.request(base + "/dialog/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        user_id: "user-1",
        client_id: "missing",
        redirect_uri: "http://evil.test",
        scope: "pages_show_list",
        state: "altered",
      }),
    });
    const location = new URL(altered.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(callback);
    expect(location.searchParams.get("state")).toBe("original");
    const tokenResponse = await exchange(app, location.searchParams.get("code") ?? "");
    const token = ((await tokenResponse.json()) as { access_token: string }).access_token;
    expect((await app.request(base + "/me/accounts?access_token=" + token)).status).toBe(403);
    expect(
      (
        await app.request(base + "/dialog/oauth/callback", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ transaction_id: transactionId, user_id: "user-1" }),
        })
      ).status,
    ).toBe(400);
  });

  it("supports bearer and query tokens for user /me", async () => {
    const token = await userToken(app, "user-1", "public_profile,pages_show_list,pages_read_engagement,email");
    const bearer = await app.request(base + "/me?fields=id,name,email", {
      headers: { authorization: "Bearer " + token },
    });
    expect(await bearer.json()).toEqual({ id: "user-1", name: "Owner", email: "owner@example.com" });
    const query = await app.request(base + "/v23.0/me?access_token=" + token);
    expect(await query.json()).toEqual({ id: "user-1", name: "Owner" });
  });

  it("omits email from /me when the token lacks the email scope", async () => {
    const token = await userToken(app);
    const response = await app.request(base + "/me?fields=id,name,email&access_token=" + token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-1", name: "Owner" });
  });

  it("enumerates only owned pages and issues a page token", async () => {
    const token = await userToken(app);
    const response = await app.request(base + "/me/accounts?access_token=" + token);
    const body = (await response.json()) as { data: Array<{ id: string; access_token: string }> };
    expect(body.data.map((page) => page.id)).toEqual(["page-1"]);
    const me = await app.request(base + "/me?access_token=" + body.data[0]?.access_token);
    expect(await me.json()).toEqual({ id: "page-1", name: "Owner Page" });
  });

  it("issues a fresh random page access token on every /me/accounts call", async () => {
    const token = await userToken(app);
    const first = (await (await app.request(base + "/me/accounts?access_token=" + token)).json()) as {
      data: Array<{ access_token: string }>;
    };
    const second = (await (await app.request(base + "/me/accounts?access_token=" + token)).json()) as {
      data: Array<{ access_token: string }>;
    };
    const firstToken = first.data[0]?.access_token ?? "";
    const secondToken = second.data[0]?.access_token ?? "";
    expect(firstToken).toMatch(/^EAA/);
    expect(firstToken).not.toContain(appId);
    expect(firstToken).not.toBe(secondToken);
    // Both tokens must still work independently.
    const meFirst = await app.request(base + "/me?access_token=" + firstToken);
    expect(((await meFirst.json()) as { id: string }).id).toBe("page-1");
    const meSecond = await app.request(base + "/me?access_token=" + secondToken);
    expect(((await meSecond.json()) as { id: string }).id).toBe("page-1");
  });

  it("returns page and video metrics only to the owning user or page", async () => {
    const token = await userToken(app);
    const video = await app.request(
      base + "/video-1?fields=id,views,likes.summary(true),comments.summary(true)&access_token=" + token,
    );
    expect(await video.json()).toEqual({
      id: "video-1",
      views: 42,
      likes: { summary: { total_count: 7 } },
      comments: { summary: { total_count: 3 } },
    });
    const denied = await app.request(base + "/video-2?access_token=" + token);
    expect(denied.status).toBe(403);
  });

  it("enforces Page permissions and returns deterministic unknown-object errors", async () => {
    const token = await userToken(app, "user-1", "public_profile");
    expect((await app.request(base + "/me/accounts?access_token=" + token)).status).toBe(403);
    expect((await app.request(base + "/page-1?access_token=" + token)).status).toBe(403);
    const unknown = await app.request(base + "/missing?access_token=" + token);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { error_subcode: number } }).error.error_subcode).toBe(33);
  });

  it("debugs valid tokens with an app access token", async () => {
    const token = await userToken(app);
    const response = await app.request(
      base + "/debug_token?input_token=" + token + "&access_token=" + appId + "|" + appSecret,
    );
    expect(((await response.json()) as { data: { is_valid: boolean; user_id: string } }).data).toMatchObject({
      is_valid: true,
      user_id: "user-1",
    });
  });

  it("does not debug a token issued to another app", async () => {
    seedFromConfig(store, base, {
      oauth_apps: [{ app_id: "app-2", app_secret: "secret-2", name: "Other App", redirect_uris: [callback] }],
    });
    const token = await userToken(app);
    const response = await app.request(base + "/debug_token?input_token=" + token + "&access_token=app-2|secret-2");
    expect(await response.json()).toEqual({ data: { is_valid: false } });
  });

  it("rejects dangling Page owner and video Page references", () => {
    expect(() =>
      seedFromConfig(new Store(), base, {
        pages: [{ id: "bad-page", name: "Bad Page", owner_user_ids: ["missing-user"] }],
      }),
    ).toThrow('Facebook Page "bad-page" references unknown owner user ID "missing-user".');
    expect(() =>
      seedFromConfig(new Store(), base, {
        page_videos: [{ id: "bad-video", page_id: "missing-page" }],
      }),
    ).toThrow('Facebook Page video "bad-video" references unknown Page ID "missing-page".');
  });

  it("rejects unsupported Graph fields with code 100", async () => {
    const token = await userToken(app);
    for (const path of ["/me", "/page-1", "/video-1"]) {
      const response = await app.request(base + path + "?fields=id,unknown&access_token=" + token);
      expect(response.status).toBe(400);
      expect((await response.json()) as object).toMatchObject({
        error: { code: 100, type: "GraphMethodException", message: expect.stringContaining("unknown") },
      });
    }
  });

  it("clears authorization state on reset", async () => {
    const query = new URLSearchParams({ client_id: appId, redirect_uri: callback, response_type: "code" });
    const page = await app.request(base + "/dialog/oauth?" + query);
    const transactionId = (await page.text()).match(/name="transaction_id" value="([^"]+)"/)?.[1] ?? "";
    const token = await userToken(app);
    store.reset();
    tokenMap.clear();
    facebookPlugin.seed?.(store, base);
    const response = await app.request(base + "/me?access_token=" + token);
    expect(response.status).toBe(401);
    const callbackResponse = await app.request(base + "/dialog/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction_id: transactionId, user_id: "100000000000001" }),
    });
    expect(callbackResponse.status).toBe(400);
  });
});
