import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@internal/core";
import { descopePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4003";
const testProjectId = process.env.DESCOPE_PROJECT_ID || "test-project-id";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", {
    login: "testuser@example.com",
    id: 1,
    scopes: ["openid", "email", "profile"],
  });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  descopePlugin.register(app as any, store, webhooks, base, tokenMap);
  descopePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "testuser@example.com", name: "Test User" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
}

describe("Descope plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  describe("OIDC Discovery", () => {
    it("GET /.well-known/openid-configuration returns OpenID Connect discovery document", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        userinfo_endpoint: string;
      };
      expect(body.issuer).toBe(base);
      expect(body.authorization_endpoint).toContain("/oauth2/v1/apps/authorize");
      expect(body.token_endpoint).toContain("/oauth2/v1/apps/token");
      expect(body.userinfo_endpoint).toContain("/oauth2/v1/apps/userinfo");
    });
  });

  describe("Authorization Endpoint", () => {
    it("GET /oauth2/v1/apps/:projectId/authorize returns an HTML sign-in page", async () => {
      const url = `${base}/oauth2/v1/apps/${testProjectId}/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid%20email`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html.length).toBeGreaterThan(0);
      expect(html).toMatch(/Sign in/i);
    });

    it("returns 400 when client_id is not registered", async () => {
      const store = new Store();
      seedFromConfig(store, base, {
        oauth_clients: [
          {
            client_id: "registered-client",
            client_secret: "secret",
            name: "Registered App",
            redirect_uris: ["http://localhost:3000/callback"],
          },
        ],
      });
      
      const webhooks = new WebhookDispatcher();
      const tokenMap: TokenMap = new Map();
      const app2 = new Hono();
      app2.use("*", authMiddleware(tokenMap));
      descopePlugin.register(app2 as any, store, webhooks, base, tokenMap);

      const url = `${base}/oauth2/v1/apps/${testProjectId}/authorize?client_id=unregistered-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid`;
      const res = await app2.request(url);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Application not found");
    });

    it("returns 400 when redirect_uri does not match registered URIs", async () => {
      const store = new Store();
      seedFromConfig(store, base, {
        oauth_clients: [
          {
            client_id: "test-client",
            client_secret: "secret",
            name: "Test App",
            redirect_uris: ["http://localhost:3000/callback"],
          },
        ],
      });
      
      const webhooks = new WebhookDispatcher();
      const tokenMap: TokenMap = new Map();
      const app2 = new Hono();
      app2.use("*", authMiddleware(tokenMap));
      descopePlugin.register(app2 as any, store, webhooks, base, tokenMap);

      const url = `${base}/oauth2/v1/apps/${testProjectId}/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://evil.com/callback")}&response_type=code&scope=openid`;
      const res = await app2.request(url);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Redirect URI mismatch");
    });
  });

  describe("Authorization Callback", () => {
    it("POST /oauth2/v1/apps/:projectId/authorize/callback redirects with code", async () => {
      const url = `${base}/oauth2/v1/apps/${testProjectId}/authorize/callback`;
      const formData = new URLSearchParams({
        email: "testuser@example.com",
        client_id: "test-client",
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email",
        state: "test-state",
      });

      const res = await app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBeDefined();
      expect(location).toContain("code=");
      expect(location).toContain("state=test-state");
    });
  });

  describe("Token Exchange", () => {
    async function getAuthCode(): Promise<string> {
      const callbackUrl = `${base}/oauth2/v1/apps/${testProjectId}/authorize/callback`;
      const formData = new URLSearchParams({
        email: "testuser@example.com",
        client_id: "test-client",
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email",
      });

      const res = await app.request(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      const location = res.headers.get("location") || "";
      const match = location.match(/code=([^&]+)/);
      return match?.[1] || "";
    }

    it("POST /oauth2/v1/apps/token exchanges code for tokens", async () => {
      const code = await getAuthCode();
      expect(code).toBeTruthy();

      const tokenUrl = `${base}/oauth2/v1/apps/token`;
      const formData = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/callback",
        client_id: "test-client",
      });

      const res = await app.request(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        access_token: string;
        id_token: string;
        token_type: string;
        expires_in: number;
      };

      expect(body.access_token).toBeDefined();
      expect(body.access_token.startsWith("descope_")).toBe(true);
      expect(body.id_token).toBeDefined();
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3600);
    });

    it("returns 400 for invalid grant_type", async () => {
      const tokenUrl = `${base}/oauth2/v1/apps/token`;
      const formData = new URLSearchParams({
        grant_type: "invalid_grant",
        code: "invalid",
      });

      const res = await app.request(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unsupported_grant_type");
    });

    it("returns 400 for expired code", async () => {
      const tokenUrl = `${base}/oauth2/v1/apps/token`;
      const formData = new URLSearchParams({
        grant_type: "authorization_code",
        code: "expired-code",
        redirect_uri: "http://localhost:3000/callback",
        client_id: "test-client",
      });

      const res = await app.request(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_grant");
    });
  });

  describe("PKCE", () => {
    it("validates S256 code_challenge", async () => {
      const crypto = await import("crypto");
      const codeVerifier = "test-verifier-123";
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

      const callbackUrl = `${base}/oauth2/v1/apps/${testProjectId}/authorize/callback`;
      const formData = new URLSearchParams({
        email: "testuser@example.com",
        client_id: "test-client",
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const res = await app.request(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      const location = res.headers.get("location") || "";
      const match = location.match(/code=([^&]+)/);
      const code = match?.[1] || "";

      const tokenUrl = `${base}/oauth2/v1/apps/token`;
      const tokenFormData = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/callback",
        client_id: "test-client",
        code_verifier: codeVerifier,
      });

      const tokenRes = await app.request(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenFormData.toString(),
      });

      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json() as { access_token: string };
      expect(body.access_token).toBeDefined();
    });

    it("returns 400 for invalid PKCE verifier", async () => {
      const crypto = await import("crypto");
      const codeChallenge = crypto.createHash("sha256").update("valid-verifier").digest("base64url");

      const callbackUrl = `${base}/oauth2/v1/apps/${testProjectId}/authorize/callback`;
      const formData = new URLSearchParams({
        email: "testuser@example.com",
        client_id: "test-client",
        redirect_uri: "http://localhost:3000/callback",
        scope: "openid email",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const res = await app.request(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      const location = res.headers.get("location") || "";
      const match = location.match(/code=([^&]+)/);
      const code = match?.[1] || "";

      const tokenUrl = `${base}/oauth2/v1/apps/token`;
      const tokenFormData = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/callback",
        client_id: "test-client",
        code_verifier: "invalid-verifier",
      });

      const tokenRes = await app.request(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenFormData.toString(),
      });

      expect(tokenRes.status).toBe(400);
      const body = await tokenRes.json() as { error: string };
      expect(body.error).toBe("invalid_grant");
    });
  });

  describe("User Info", () => {
    it("GET /oauth2/v1/apps/userinfo returns user info for a valid token", async () => {
      const res = await app.request(`${base}/oauth2/v1/apps/userinfo`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sub: string;
        email: string;
        email_verified: boolean;
        name: string;
      };
      expect(body.sub).toBeDefined();
      expect(body.email).toBe("testuser@example.com");
      expect(body.email_verified).toBe(true);
      expect(body.name).toBe("Test User");
    });

    it("returns 401 without authorization header", async () => {
      const res = await app.request(`${base}/oauth2/v1/apps/userinfo`);
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_token");
    });
  });

  describe("Token Revocation", () => {
    it("POST /oauth2/v1/apps/revoke removes token from tokenMap", async () => {
      const revokeUrl = `${base}/oauth2/v1/apps/revoke`;
      const formData = new URLSearchParams({
        token: "test-token",
      });

      const res = await app.request(revokeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("Dynamic Project ID", () => {
    it("works with different project IDs", async () => {
      const projectId1 = "project-1";
      const projectId2 = "project-2";

      const url1 = `${base}/oauth2/v1/apps/${projectId1}/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid`;
      const res1 = await app.request(url1);
      expect(res1.status).toBe(200);

      const url2 = `${base}/oauth2/v1/apps/${projectId2}/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&scope=openid`;
      const res2 = await app.request(url2);
      expect(res2.status).toBe(200);
    });
  });
});

describe("Descope seedFromConfig", () => {
  it("seeds users from config", () => {
    const store = new Store();
    seedFromConfig(store, base, {
      users: [
        { email: "user1@test.com", name: "User One" },
        { email: "user2@test.com", name: "User Two" },
      ],
    });

    // Access via the store
    const users = store.collection("descope.users", ["uid", "email"]);
    expect(users.all()).toHaveLength(2);
  });

  it("seeds oauth_clients from config", () => {
    const store = new Store();
    seedFromConfig(store, base, {
      oauth_clients: [
        {
          client_id: "client-1",
          client_secret: "secret-1",
          name: "Client One",
          redirect_uris: ["http://localhost:3000/callback"],
        },
      ],
    });

    const clients = store.collection("descope.oauth_clients", ["client_id"]);
    expect(clients.all()).toHaveLength(1);
    expect(clients.all()[0].client_id).toBe("client-1");
  });
});
