import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const client = { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-a+b/c=d" };
const redirectUri = "http://127.0.0.1:8080/";
const email = "admin@example.com";

function fixture() {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    strict_scopes: true,
    users: [{ email, name: "Ada Admin" }],
    oauth_clients: [{ ...client, redirect_uris: [redirectUri] }],
  });

  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });

  async function code(): Promise<string> {
    const authorize = await form("/o/oauth2/v2/auth/callback", {
      email,
      redirect_uri: redirectUri,
      scope: "openid email",
      client_id: client.client_id,
    });
    return new URL(authorize.headers.get("Location")!).searchParams.get("code")!;
  }

  return { form, code };
}

// RFC 6749, section 2.3.1: each credential is form-urlencoded, then joined with a colon and base64-encoded.
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

describe("Google token endpoint client authentication", () => {
  it("accepts client credentials in an HTTP Basic Authorization header", async () => {
    const { form, code } = fixture();
    const exchange = await form(
      "/oauth2/token",
      { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri },
      { Authorization: basic(client.client_id, client.client_secret) },
    );
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as { refresh_token: string };

    const refreshed = await form(
      "/oauth2/token",
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      { Authorization: basic(client.client_id, client.client_secret) },
    );
    expect(refreshed.status).toBe(200);
  });

  it("refuses a wrong secret or an unknown client in the header", async () => {
    const { form, code } = fixture();
    for (const header of [basic(client.client_id, "GOCSPX-wrong"), basic("unknown", client.client_secret)]) {
      const exchange = await form(
        "/oauth2/token",
        { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri },
        { Authorization: header },
      );
      expect(exchange.status).toBe(401);
      // Google's token endpoint sends no WWW-Authenticate challenge here, despite RFC 6749 section 5.2.
      expect(exchange.headers.get("WWW-Authenticate")).toBeNull();
      expect(await exchange.json()).toMatchObject({ error: "invalid_client" });
    }
  });

  it("refuses body credentials that do not match the header", async () => {
    const { form, code } = fixture();
    const mismatches: Record<string, string>[] = [
      { client_id: client.client_id, client_secret: "GOCSPX-other" },
      { client_secret: "GOCSPX-other" },
      { client_secret: client.client_secret },
      { client_id: "123-other.apps.googleusercontent.com" },
    ];
    for (const extra of mismatches) {
      const exchange = await form(
        "/oauth2/token",
        { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri, ...extra },
        { Authorization: basic(client.client_id, client.client_secret) },
      );
      expect(exchange.status).toBe(400);
      expect(exchange.headers.get("WWW-Authenticate")).toBeNull();
      expect(await exchange.json()).toEqual({
        error: "invalid_request",
        error_description: "Credentials in post body and basic Authorization header do not match",
      });
    }
  });

  it("accepts body credentials that match the header, and ignores an empty body secret", async () => {
    const { form, code } = fixture();
    const matches: Record<string, string>[] = [
      { client_id: client.client_id, client_secret: client.client_secret },
      { client_id: client.client_id },
      { client_secret: "" },
    ];
    for (const extra of matches) {
      const exchange = await form(
        "/oauth2/token",
        { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri, ...extra },
        { Authorization: basic(client.client_id, client.client_secret) },
      );
      expect(exchange.status).toBe(200);
    }
  });

  it("keeps client credentials in the body", async () => {
    const { form, code } = fixture();
    const exchange = await form("/oauth2/token", {
      ...client,
      grant_type: "authorization_code",
      code: await code(),
      redirect_uri: redirectUri,
    });
    expect(exchange.status).toBe(200);
  });
});
