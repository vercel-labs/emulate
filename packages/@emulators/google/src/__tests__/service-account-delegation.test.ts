import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from "jose";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const tokenUrl = "https://oauth2.googleapis.com/token";
const gmailInsert = "https://www.googleapis.com/auth/gmail.insert";
const gmailReadonly = "https://www.googleapis.com/auth/gmail.readonly";
const account = "mail-archiver@clinic-project.iam.gserviceaccount.com";
const clientId = "104598730215648392017";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicKey: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  publicKey = await exportSPKI(pair.publicKey);
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

function fixture(delegatedScopes: string[] | null = [gmailInsert]) {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    strict_scopes: true,
    users: [{ email: "alice@clinic.example", hd: "clinic.example" }],
    oauth_clients: [{ client_id: "web-client", client_secret: "web-secret", redirect_uris: ["http://localhost/cb"] }],
    service_accounts: [
      {
        client_email: account,
        client_id: clientId,
        keys: [
          { id: "old-key", public_key: publicKey.replace(/[A-Za-z]{8}\n/, "AAAAAAAA\n") },
          { id: "current-key", public_key: publicKey },
        ],
      },
    ],
    domain_wide_delegation: delegatedScopes ? [{ client_id: clientId, scopes: delegatedScopes }] : [],
  });

  async function exchange(assertion: string) {
    const res = await app.request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  function insert(token: string) {
    return app.request(`${base}/gmail/v1/users/me/messages/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: Buffer.from(
          "From: lab@partner.example\r\nTo: alice@clinic.example\r\nSubject: Results\r\n\r\nOK",
        ).toString("base64url"),
        labelIds: ["INBOX", "UNREAD"],
      }),
    });
  }

  return { exchange, insert };
}

async function assertion(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; kid?: string; iat?: number; exp?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const iat = options.iat ?? now;
  return new SignJWT({ scope: gmailInsert, ...claims })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: options.kid ?? "current-key" })
    .setIssuer(typeof claims.iss === "string" ? claims.iss : account)
    .setAudience(tokenUrl)
    .setIssuedAt(iat)
    .setExpirationTime(options.exp ?? iat + 3600)
    .sign(options.key ?? signingKey);
}

describe("Google service accounts with domain-wide delegation", () => {
  it("issues a token acting as the delegated user without OAuth client credentials, which Gmail accepts", async () => {
    const { exchange, insert } = fixture();
    const issued = await exchange(await assertion({ sub: "alice@clinic.example" }));
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ scope: gmailInsert, token_type: "Bearer", expires_in: 3600 });
    expect(issued.body.refresh_token).toBeUndefined();

    const res = await insert(issued.body.access_token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { labelIds: string[] }).labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("tries every key of the account when the key ID does not match", async () => {
    const { exchange } = fixture();
    expect((await exchange(await assertion({ sub: "alice@clinic.example" }, { kid: "unknown" }))).status).toBe(200);
  });

  it("refuses a client not authorized for domain-wide delegation", async () => {
    const { exchange } = fixture(null);
    const refused = await exchange(await assertion({ sub: "alice@clinic.example" }));
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({
      error: "unauthorized_client",
      error_description: "Unauthorized client or scope in request.",
    });
  });

  it("refuses scopes the delegation does not grant, and tokens used beyond their scopes", async () => {
    const { exchange, insert } = fixture([gmailReadonly]);
    const refused = await exchange(
      await assertion({ sub: "alice@clinic.example", scope: `${gmailReadonly} ${gmailInsert}` }),
    );
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "access_denied", error_description: "Requested client not authorized." });

    const reader = await exchange(await assertion({ sub: "alice@clinic.example", scope: gmailReadonly }));
    expect(reader.status).toBe(200);
    expect((await insert(reader.body.access_token)).status).toBe(403);
  });

  it("refuses assertions Google refuses, with Google's errors", async () => {
    const { exchange, insert } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[Promise<string>, string, string]> = [
      [assertion({ sub: "alice@clinic.example" }, { key: otherKey }), "invalid_grant", "Invalid JWT Signature."],
      [assertion({ sub: "nobody@clinic.example" }), "invalid_grant", "Invalid email or User ID"],
      [
        assertion({ sub: "alice@clinic.example", iss: "deleted@clinic-project.iam.gserviceaccount.com" }),
        "invalid_grant",
        "Invalid grant: account not found",
      ],
      [
        assertion({ sub: "alice@clinic.example", scope: "" }),
        "invalid_scope",
        "Invalid OAuth scope or ID token audience provided.",
      ],
      [
        assertion({ sub: "alice@clinic.example" }, { iat: now, exp: now + 2 * 3600 }),
        "invalid_grant",
        "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your 'iat' and 'exp' values and use a clock with skew to account for clock differences between systems.",
      ],
      [
        assertion({ sub: "alice@clinic.example" }, { iat: now - 7200, exp: now - 3600 }),
        "invalid_grant",
        "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your 'iat' and 'exp' values and use a clock with skew to account for clock differences between systems.",
      ],
    ];
    for (const [pending, code, description] of cases) {
      const res = await exchange(await pending);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).toEqual({ error: code, error_description: description });
    }
    expect((await insert("not-a-token")).status).toBe(401);
  });
});
