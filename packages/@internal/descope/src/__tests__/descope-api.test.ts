import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher } from "@internal/core";
import { descopePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4003";
const testProjectId = process.env.DESCOPE_PROJECT_ID || "test-project-id";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();

  const app = new Hono();
  descopePlugin.register(app as any, store, webhooks, base, undefined);
  descopePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { email: "testuser@example.com", name: "Test User" },
      { email: "admin@example.com", name: "Admin User" },
    ],
  });

  return { app, store, webhooks };
}

function authHeaders(projectId: string = testProjectId): HeadersInit {
  return { Authorization: `Bearer ${projectId}` };
}

describe("Descope Proprietary API", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  describe("POST /v1/auth/oauth/authorize", () => {
    it("returns authorization URL with picker", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBeDefined();
      expect(body.url).toContain("/v1/auth/oauth/authorize/picker");
      expect(body.url).toContain("code=");
      expect(body.url).toContain("project_id=");
    });

    it("requires project ID in Authorization header", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_project");
    });

    it("handles different providers", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          redirectUrl: "http://localhost:3000/callback",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBeDefined();
    });

    it("handles pkceChallenge", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
          pkceChallenge: "test-challenge-123",
        }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /v1/auth/oauth/authorize/picker", () => {
    async function getAuthorizationCode(): Promise<string> {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
        }),
      });
      const body = (await res.json()) as { url: string };
      const url = new URL(body.url);
      return url.searchParams.get("code") || "";
    }

    it("returns HTML user picker", async () => {
      const code = await getAuthorizationCode();
      expect(code).toBeTruthy();

      const res = await app.request(
        `${base}/v1/auth/oauth/authorize/picker?code=${code}&project_id=${testProjectId}`
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain("testuser@example.com");
    });

    it("returns error for invalid code", async () => {
      const res = await app.request(
        `${base}/v1/auth/oauth/authorize/picker?code=invalid-code&project_id=${testProjectId}`
      );

      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/auth/oauth/authorize/complete", () => {
    async function getAuthorizationCode(): Promise<string> {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
        }),
      });
      const body = (await res.json()) as { url: string };
      const url = new URL(body.url);
      return url.searchParams.get("code") || "";
    }

    it("redirects to callback URL with code", async () => {
      const code = await getAuthorizationCode();
      expect(code).toBeTruthy();

      const res = await app.request(`${base}/v1/auth/oauth/authorize/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          email: "testuser@example.com",
        }).toString(),
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("http://localhost:3000/callback");
      expect(location).toContain(`code=${code}`);
    });
  });

  describe("POST /v1/auth/oauth/exchange", () => {
    async function completeAuthorizationFlow(): Promise<string> {
      // Step 1: Start authorization
      const authorizeRes = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
        }),
      });
      const authorizeBody = (await authorizeRes.json()) as { url: string };
      const url = new URL(authorizeBody.url);
      const code = url.searchParams.get("code") || "";

      // Step 2: Complete user selection
      await app.request(`${base}/v1/auth/oauth/authorize/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          email: "testuser@example.com",
        }).toString(),
      });

      return code;
    }

    it("exchanges code for AuthenticationInfo", async () => {
      const code = await completeAuthorizationFlow();
      expect(code).toBeTruthy();

      const res = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionToken: { jwt: string; expiration: number };
        refreshToken: { jwt: string; expiration: number };
        user: { userId: string; email: string; name: string };
        firstSeen: boolean;
      };

      expect(body.sessionToken.jwt).toBeDefined();
      expect(body.sessionToken.expiration).toBeGreaterThan(Date.now());
      expect(body.refreshToken.jwt).toBeDefined();
      expect(body.user.email).toBe("testuser@example.com");
      expect(body.user.name).toBe("Test User");
      expect(body.firstSeen).toBe(false);
    });

    it("returns error for invalid code", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: "invalid-code" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    it("requires project ID in Authorization header", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "test-code" }),
      });

      expect(res.status).toBe(400);
    });

    it("includes OAuth provider info in user", async () => {
      const code = await completeAuthorizationFlow();

      const res = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });

      const body = (await res.json()) as {
        user: { OAuth: Record<string, boolean> };
      };

      expect(body.user.OAuth.google).toBe(true);
    });
  });

  describe("Authorization Header Parsing", () => {
    it("handles Bearer <ProjectID> format", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google" }),
      });

      expect(res.status).toBe(200);
    });

    it("handles Bearer <ProjectID>:<RefreshJWT> format", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}:some-refresh-jwt`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("Full OAuth Flow", () => {
    it("completes end-to-end OAuth flow", async () => {
      // Step 1: Start OAuth
      const authorizeRes = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          redirectUrl: "http://localhost:3000/callback",
          loginHint: "testuser@example.com",
        }),
      });

      expect(authorizeRes.status).toBe(200);
      const { url } = (await authorizeRes.json()) as { url: string };
      expect(url).toContain("/v1/auth/oauth/authorize/picker");

      // Step 2: Parse picker URL
      const pickerUrl = new URL(url);
      const code = pickerUrl.searchParams.get("code") || "";
      expect(code).toBeTruthy();

      // Step 3: Complete authorization
      const completeRes = await app.request(`${base}/v1/auth/oauth/authorize/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          email: "testuser@example.com",
        }).toString(),
      });

      expect(completeRes.status).toBe(302);
      const location = completeRes.headers.get("location") || "";
      expect(location).toContain("code=");

      // Step 4: Extract code from redirect
      const redirectUrl = new URL(location);
      const finalCode = redirectUrl.searchParams.get("code") || "";
      expect(finalCode).toBeTruthy();

      // Step 5: Exchange code for tokens
      const exchangeRes = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: finalCode }),
      });

      expect(exchangeRes.status).toBe(200);
      const authInfo = (await exchangeRes.json()) as {
        sessionToken: { jwt: string };
        refreshToken: { jwt: string };
        user: { userId: string; email: string };
      };

      expect(authInfo.sessionToken.jwt).toBeTruthy();
      expect(authInfo.refreshToken.jwt).toBeTruthy();
      expect(authInfo.user.email).toBe("testuser@example.com");
    });
  });

  describe("Edge Cases", () => {
    it("handles expired authorization codes", async () => {
      // Create an expired code manually by manipulating store
      const { store } = createTestApp();
      const pendingAuth = {
        code: "expired-code",
        projectId: testProjectId,
        provider: "google",
        redirectUrl: "http://localhost:3000/callback",
        email: "test@example.com",
        createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago (expired)
      };
      store.setData("descope.oauth.pendingAuth", new Map([["expired-code", pendingAuth]]));

      const res = await app.request(`${base}/v1/auth/oauth/exchange`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: "expired-code" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    it("handles missing custom claims", async () => {
      const res = await app.request(`${base}/v1/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testProjectId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          customClaims: { custom: "value" },
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
