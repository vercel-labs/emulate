import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig, type GoogleSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const tokenUrl = "https://oauth2.googleapis.com/token";
const gmailReadonly = "https://www.googleapis.com/auth/gmail.readonly";
const gmailSend = "https://www.googleapis.com/auth/gmail.send";
const calendar = "https://www.googleapis.com/auth/calendar";
const serviceAccount = "archiver@emulate-project.iam.gserviceaccount.com";
const clientId = "104523180291234567890";

// A certificate only, from a throwaway key pair whose private key was discarded.
const certificate = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDLzCCAhegAwIBAgIUbX/vBrxXw8DC79AUKjg6SV8zILYwDQYJKoZIhvcNAQEL",
  "BQAwJzElMCMGA1UEAwwcZW11bGF0ZS10ZXN0LXNlcnZpY2UtYWNjb3VudDAeFw0y",
  "NjExMTQwMTEwNDBaFw0zNjExMTEwMTEwNDBaMCcxJTAjBgNVBAMMHGVtdWxhdGUt",
  "dGVzdC1zZXJ2aWNlLWFjY291bnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK",
  "AoIBAQCei2FE/D0EeiIRkmFi1X9wuKoo/w/XX7TBd2QpjFPZPXN5H86Ty/8cGjHg",
  "K02sgA+S+Ba8xYc6lNp+mJ0RpIk2T5A+QRNmDEN0OuYu1wDT6mEMW2JXAvzNxZw6",
  "opXNt9rBOVmLH6xXs0wn/oflli3U5ux0tloaF9JiY6eufha0FqUcxQHmXpCvDbtv",
  "D6uO2rZw1XxDXG0wbrD/oDf0xectTvX5rdOaSwRHEdlGt2pZSNyVp2LTA7753fJr",
  "9CxZb+63R5fw+c0aJtasyOYt4hABx209Zg9CmEXrlGcIYa65QdGh4JMN/awQtbzh",
  "t/EaoqC1HaiK/e7vhahbWnguteCbAgMBAAGjUzBRMB0GA1UdDgQWBBSPuZspfLhg",
  "HMGYW6isov1s6wTo4DAfBgNVHSMEGDAWgBSPuZspfLhgHMGYW6isov1s6wTo4DAP",
  "BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB4g48WQirU7ZAOeppA",
  "RRrmSVdSsWZBj6gcNHhAJxQjZ8XGFwNHn2/uZ8utrFVy4ECOYxr9AWw3dcXaIuVr",
  "Q6+uJ1k8FELszKHhLrjKhzIuPpEVbwEVdfsWKdDRKvg9K7YnsXgqBUwQB41lqTP/",
  "XhFWwvkwO7MKVmRnZgSL8zCgOhlDfUFUBNlhHr7UTJJJfsY9LP0nXAekgf4dZ3U+",
  "KS2A5nUvk7lQ7ltnUVZRX6pk0/BP+F/2oH3EmtVYzAoBCOh6ucqlfij8RjxjGzkz",
  "ZLlpKiqo/pnN5XMlXbm0uGy/N0jrm7DhylaATpmrIMKmgtFQTFq5xkl1MSOqK/Cb",
  "+tkt",
  "-----END CERTIFICATE-----",
].join("\n");

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const signing = keyPair();
const rotated = keyPair();

function fixture(overrides: Partial<GoogleSeedConfig> = {}) {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    strict_scopes: true,
    users: [{ email: "alice@example.com" }],
    messages: [
      {
        id: "msg",
        user_email: "alice@example.com",
        from: "bob@example.com",
        to: "alice@example.com",
        body_text: "Hi",
        label_ids: ["INBOX"],
      },
    ],
    service_accounts: [
      {
        client_email: serviceAccount,
        client_id: clientId,
        keys: [
          { key_id: "old-key", public_key: rotated.publicKey.export({ type: "spki", format: "pem" }).toString() },
          { key_id: "current-key", public_key: signing.publicKey.export({ type: "spki", format: "pem" }).toString() },
        ],
      },
    ],
    domain_wide_delegation: [{ client_id: clientId, scopes: [gmailReadonly, gmailSend] }],
    ...overrides,
  });

  async function exchange(assertion: string) {
    const res = await app.request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  const gmail = (token: string) =>
    app.request(`${base}/gmail/v1/users/me/messages`, { headers: { Authorization: `Bearer ${token}` } });

  return { exchange, gmail };
}

async function assertion(
  claims: Record<string, unknown> = {},
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: serviceAccount, scope: gmailReadonly, aud: tokenUrl, iat: now, exp: now + 3600, ...claims })
    .setProtectedHeader({ alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? "current-key" })
    .sign(options.key ?? signing.privateKey);
}

const shortLived =
  "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.";

describe("Google service account tokens", () => {
  it("issues a one-hour token without a refresh token that acts as the delegated user", async () => {
    const { exchange, gmail } = fixture();
    const res = await exchange(await assertion({ sub: "alice@example.com" }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      access_token: expect.stringMatching(/^google_/),
      expires_in: 3600,
      scope: gmailReadonly,
      token_type: "Bearer",
    });

    const list = await gmail(res.json.access_token);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual(["msg"]);
  });

  it("limits a delegated token to its requested scopes under strict_scopes", async () => {
    const { exchange, gmail } = fixture();
    const res = await exchange(await assertion({ sub: "alice@example.com", scope: gmailSend }));
    expect(res.status).toBe(200);
    expect((await gmail(res.json.access_token)).status).toBe(403);
  });

  it("issues a token for the service account itself without sub", async () => {
    const { exchange } = fixture({ domain_wide_delegation: [] });
    const res = await exchange(await assertion({ scope: `${gmailReadonly} ${calendar}` }));
    expect(res.status).toBe(200);
    expect(res.json.scope).toBe(`${gmailReadonly} ${calendar}`);
  });

  it("tries every key when the key ID is wrong or missing", async () => {
    const { exchange } = fixture();
    expect((await exchange(await assertion({}, { kid: "unknown-key" }))).status).toBe(200);
    expect((await exchange(await assertion({}, { kid: "old-key" }))).status).toBe(200);
    expect((await exchange(await assertion({}, { key: rotated.privateKey, kid: "current-key" }))).status).toBe(200);
  });

  it("returns Google's errors for bad assertions", async () => {
    const { exchange } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const other = keyPair();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["not-a-jwt", { error: "invalid_request", error_description: "Bad Request" }],
      [
        await assertion({ scope: "" }),
        { error: "invalid_scope", error_description: "Invalid OAuth scope or ID token audience provided." },
      ],
      [
        await assertion({ sub: "nobody@example.com" }),
        { error: "invalid_grant", error_description: "Not a valid email or user ID." },
      ],
      [
        await assertion({ iss: "unknown@emulate-project.iam.gserviceaccount.com" }),
        { error: "invalid_grant", error_description: "Invalid grant: account not found" },
      ],
      [
        await assertion({}, { key: other.privateKey }),
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
      ],
      [
        await assertion({}, { key: other.privateKey, alg: "RS384" }),
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
      ],
      [
        await assertion({ aud: "https://example.com/token" }),
        { error: "invalid_grant", error_description: "Invalid JWT: Invalid audience." },
      ],
      [await assertion({ iat: now, exp: now + 66 * 60 }), { error: "invalid_grant", error_description: shortLived }],
      [await assertion({ iat: now, exp: now - 60 }), { error: "invalid_grant", error_description: shortLived }],
      [
        await assertion({ iat: now - 2 * 3600, exp: now - 3600 }),
        { error: "invalid_grant", error_description: shortLived },
      ],
    ];
    for (const [jwt, expected] of cases) {
      const res = await exchange(jwt);
      expect(res.status, JSON.stringify(expected)).toBe(400);
      expect(res.json).toEqual(expected);
    }
  });

  it("accepts the older token URLs as the audience", async () => {
    const { exchange } = fixture();
    for (const aud of ["https://accounts.google.com/o/oauth2/token", "https://www.googleapis.com/oauth2/v4/token"]) {
      expect((await exchange(await assertion({ aud }))).status, aud).toBe(200);
    }
  });

  it("refuses delegation the Admin console has not granted", async () => {
    const noDelegation = fixture({ domain_wide_delegation: [] });
    expect(await noDelegation.exchange(await assertion({ sub: "alice@example.com" }))).toEqual({
      status: 401,
      json: { error: "unauthorized_client", error_description: "Unauthorized client or scope in request." },
    });

    const { exchange } = fixture();
    expect(await exchange(await assertion({ sub: "alice@example.com", scope: calendar }))).toEqual({
      status: 401,
      json: {
        error: "unauthorized_client",
        error_description:
          "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.",
      },
    });
    expect(
      await exchange(await assertion({ sub: "alice@example.com", scope: `${gmailReadonly} ${calendar}` })),
    ).toEqual({
      status: 403,
      json: { error: "access_denied", error_description: "Requested client not authorized." },
    });
  });

  it("accepts an X.509 certificate as a key and rejects keys that are not PEM", async () => {
    const { exchange } = fixture({
      service_accounts: [
        { client_email: serviceAccount, client_id: clientId, keys: [{ key_id: "cert", public_key: certificate }] },
      ],
    });
    // The signing key is not the certificate's, so the account exists but the signature fails.
    expect((await exchange(await assertion())).json.error_description).toBe("Invalid JWT Signature.");

    expect(() =>
      fixture({
        service_accounts: [
          { client_email: serviceAccount, client_id: clientId, keys: [{ key_id: "x", public_key: "nope" }] },
        ],
      }),
    ).toThrow(/not a PEM public key or certificate/);
  });
});
