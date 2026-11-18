import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const redirectUri = "http://localhost/callback";
const client = { client_id: "basic-client.apps.googleusercontent.com", client_secret: "basic-secret" };

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fixture(options: { strict?: boolean; clients?: boolean } = {}) {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    ...(options.strict === undefined ? {} : { strict_scopes: options.strict }),
    users: [{ email: "alice@example.com", name: "Alice Example" }],
    ...(options.clients === false ? {} : { oauth_clients: [{ ...client, redirect_uris: [redirectUri] }] }),
  });

  async function code(): Promise<string> {
    const res = await app.request(`${base}/o/oauth2/v2/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "alice@example.com",
        redirect_uri: redirectUri,
        scope: "openid email",
        client_id: client.client_id,
      }).toString(),
    });
    return new URL(res.headers.get("Location")!).searchParams.get("code")!;
  }

  async function token(body: Record<string, string>, authorization?: string) {
    const res = await app.request(`${base}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
  }

  return { code, token };
}

const mismatch = {
  error: "invalid_request",
  error_description: "Credentials in post body and basic Authorization header do not match",
};

describe("Google token endpoint client_secret_basic", () => {
  for (const strict of [false, true]) {
    it(`exchanges a code and a refresh token with Basic credentials (strict_scopes ${strict})`, async () => {
      const { code, token } = fixture({ strict });
      const header = basic(client.client_id, client.client_secret);
      const exchanged = await token(
        { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri },
        header,
      );
      expect(exchanged.status).toBe(200);
      expect(exchanged.json.access_token).toBeTruthy();

      const refreshed = await token(
        { grant_type: "refresh_token", refresh_token: exchanged.json.refresh_token },
        header,
      );
      expect(refreshed.status).toBe(200);
      expect(refreshed.json.access_token).toBeTruthy();
    });
  }

  it("accepts body credentials that repeat the header's", async () => {
    const { code, token } = fixture();
    const header = basic(client.client_id, client.client_secret);
    const grant = { grant_type: "authorization_code", redirect_uri: redirectUri };
    const extras: Array<Record<string, string>> = [
      { ...client },
      { client_id: client.client_id },
      { client_id: client.client_id, client_secret: "" },
    ];
    for (const extra of extras) {
      const res = await token({ ...grant, code: await code(), ...extra }, header);
      expect(res.status, JSON.stringify(extra)).toBe(200);
    }
  });

  it("refuses body credentials that differ from the header's", async () => {
    const { code, token } = fixture();
    const header = basic(client.client_id, client.client_secret);
    const grant = { grant_type: "authorization_code", redirect_uri: redirectUri, code: await code() };
    const extras: Array<Record<string, string>> = [
      { client_id: "other-client" },
      { client_id: client.client_id, client_secret: "other-secret" },
      // A body secret needs its client_id, even when it equals the header's secret.
      { client_secret: client.client_secret },
    ];
    for (const extra of extras) {
      const res = await token({ ...grant, ...extra }, header);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json).toEqual(mismatch);
    }
    // The code was not used up by the refused requests.
    expect((await token(grant, header)).status).toBe(200);
  });

  it("compares Basic credentials as sent, without form-decoding them", async () => {
    const { code, token } = fixture();
    const grant = { grant_type: "authorization_code", redirect_uri: redirectUri, code: await code() };
    const encodedId = client.client_id.replace(/\./g, "%2E");
    expect(
      (await token({ ...grant, client_id: client.client_id }, basic(encodedId, client.client_secret))).json,
    ).toEqual(mismatch);
    const unknown = await token(grant, basic(encodedId, client.client_secret));
    expect(unknown.status).toBe(401);
    expect(unknown.json.error).toBe("invalid_client");
  });

  it("returns invalid_client for a wrong header secret or client, without WWW-Authenticate", async () => {
    const { code, token } = fixture();
    const grant = { grant_type: "authorization_code", redirect_uri: redirectUri, code: await code() };
    const wrongSecret = await token(grant, basic(client.client_id, "wrong"));
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.json).toEqual({ error: "invalid_client", error_description: "The client_secret is incorrect." });
    expect(wrongSecret.headers.get("WWW-Authenticate")).toBeNull();

    const wrongClient = await token(grant, basic("other-client", client.client_secret));
    expect(wrongClient.status).toBe(401);
    expect(wrongClient.json.error).toBe("invalid_client");
  });

  it("returns invalid_request for a malformed header or an empty client ID", async () => {
    const { code, token } = fixture();
    const grant = { grant_type: "authorization_code", redirect_uri: redirectUri, code: await code() };
    const malformed = await token(grant, `Basic ${Buffer.from("no-colon").toString("base64")}`);
    expect(malformed.status).toBe(400);
    expect(malformed.json).toEqual({ error: "invalid_request", error_description: "Bad Request" });

    const empty = await token(grant, basic("", client.client_secret));
    expect(empty.status).toBe(400);
    expect(empty.json).toEqual({
      error: "invalid_request",
      error_description: "Could not determine client ID from request.",
    });
  });

  it("refreshes a token from a body-credential exchange with Basic credentials", async () => {
    const { code, token } = fixture();
    const exchanged = await token({
      grant_type: "authorization_code",
      code: await code(),
      redirect_uri: redirectUri,
      ...client,
    });
    const res = await token(
      { grant_type: "refresh_token", refresh_token: exchanged.json.refresh_token },
      basic(client.client_id, client.client_secret),
    );
    expect(res.status).toBe(200);
  });

  it("ignores client credentials when no OAuth clients are configured", async () => {
    const { code, token } = fixture({ clients: false });
    const res = await token(
      { grant_type: "authorization_code", code: await code(), redirect_uri: redirectUri, client_id: "anything" },
      basic("other", "secret"),
    );
    expect(res.status).toBe(200);
  });
});
