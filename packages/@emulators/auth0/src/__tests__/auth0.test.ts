import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { auth0Plugin, getAuth0Store, seedFromConfig } from "../index.js";

const base = "http://localhost:4012";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("mgmt-token", { login: "admin@auth0.local", id: 1, scopes: ["read:users", "update:users"] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  auth0Plugin.register(app as any, store, webhooks, base, tokenMap);
  auth0Plugin.seed?.(store, base);
  seedFromConfig(store, base, {
    tenant: "acme",
    applications: [
      {
        client_id: "custom-client",
        client_secret: "custom-secret",
        name: "Custom App",
        callbacks: ["http://localhost:3000/custom-callback"],
        grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      },
      {
        client_id: "public-client",
        name: "Public App",
        callbacks: ["http://localhost:3000/public-callback"],
        token_endpoint_auth_method: "none",
      },
    ],
    users: [{ email: "alice@example.com", name: "Alice Example", password: "pass" }],
    roles: [{ id: "rol_admin", name: "admin", description: "Admin" }],
    organizations: [{ id: "org_acme", name: "acme", display_name: "Acme", members: ["alice@example.com"] }],
    connections: [{ name: "google-oauth2", strategy: "google-oauth2", enabled_clients: ["custom-client"] }],
    apis: [{ audience: "https://api.acme.test/", name: "Acme API", scopes: ["read:messages"] }],
    role_assignments: [{ user_id: "alice@example.com", role_id: "admin" }],
  });
  return { app, store, tokenMap };
}

function managementHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer mgmt-token",
    "Content-Type": "application/json",
  };
}

async function getAuthCode(
  app: Hono,
  store: Store,
  options: {
    userRef?: string;
    redirectUri?: string;
    clientId?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    responseMode?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    audience?: string;
    organization?: string;
  } = {},
): Promise<{ code: string; state: string; response: Response }> {
  const auth0 = getAuth0Store(store);
  const userRef = options.userRef ?? auth0.users.findOneBy("email", "alice@example.com")?.auth0_id ?? "";
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const clientId = options.clientId ?? "auth0-test-client";
  const formData = new URLSearchParams({
    user_ref: userRef,
    redirect_uri: redirectUri,
    scope: options.scope ?? "openid profile email",
    state: options.state ?? "state-1",
    nonce: options.nonce ?? "nonce-1",
    client_id: clientId,
    response_mode: options.responseMode ?? "query",
    code_challenge: options.codeChallenge ?? "",
    code_challenge_method: options.codeChallengeMethod ?? "",
    audience: options.audience ?? "",
    organization: options.organization ?? "",
    issuer: `${base}/?tenant=acme`,
    tenant: "acme",
  });

  const response = await app.request(`${base}/u/login/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (options.responseMode === "form_post") {
    const html = await response.text();
    return {
      code: html.match(/name="code" value="([^"]+)"/)?.[1] ?? "",
      state: html.match(/name="state" value="([^"]+)"/)?.[1] ?? "",
      response,
    };
  }

  const location = response.headers.get("location") ?? "";
  const locationUrl = new URL(location);
  return {
    code: locationUrl.searchParams.get("code") ?? "",
    state: locationUrl.searchParams.get("state") ?? "",
    response,
  };
}

async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    clientId?: string;
    clientSecret?: string;
    includeClientSecret?: boolean;
    redirectUri?: string;
    codeVerifier?: string;
    useBasicAuth?: boolean;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.clientId ?? "auth0-test-client",
    redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
  });
  if (options.includeClientSecret ?? true) body.set("client_secret", options.clientSecret ?? "auth0-test-secret");
  if (options.codeVerifier) body.set("code_verifier", options.codeVerifier);

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (options.useBasicAuth) {
    const creds = Buffer.from(
      `${options.clientId ?? "auth0-test-client"}:${options.clientSecret ?? "auth0-test-secret"}`,
    ).toString("base64");
    headers.Authorization = `Basic ${creds}`;
    body.delete("client_id");
    body.delete("client_secret");
  }

  return app.request(`${base}/oauth/token`, { method: "POST", headers, body: body.toString() });
}

describe("Auth0 plugin integration", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  describe("OIDC discovery and JWKS", () => {
    it("returns tenant-aware discovery document", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe("http://acme.auth0.localhost:4012");
      expect(body.authorization_endpoint).toBe("http://acme.auth0.localhost:4012/authorize");
      expect(body.token_endpoint).toBe("http://acme.auth0.localhost:4012/oauth/token");
      expect(body.userinfo_endpoint).toBe("http://acme.auth0.localhost:4012/userinfo");
      expect(body.jwks_uri).toBe("http://acme.auth0.localhost:4012/.well-known/jwks.json");
      expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
    });

    it("supports query-param tenant mode", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration?tenant=querytenant`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(`${base}/?tenant=querytenant`);
      expect(body.authorization_endpoint).toBe(`${base}/authorize?tenant=querytenant`);
      expect(body.token_endpoint).toBe(`${base}/oauth/token?tenant=querytenant`);
    });

    it("supports auth0.localhost subdomain mode", async () => {
      const res = await app.request("http://subtenant.auth0.localhost:4012/.well-known/openid-configuration");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe("http://subtenant.auth0.localhost:4012");
      expect(body.authorization_endpoint).toBe("http://subtenant.auth0.localhost:4012/authorize");
    });

    it("returns JWKS", async () => {
      const res = await app.request(`${base}/.well-known/jwks.json`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kty).toBe("RSA");
      expect(body.keys[0].kid).toBe("emulate-auth0-1");
      expect(body.keys[0].alg).toBe("RS256");
    });
  });

  describe("Universal Login", () => {
    it("returns sign-in HTML page from authorize", async () => {
      const res = await app.request(
        `${base}/authorize?client_id=auth0-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain("Auth0");
    });

    it("returns 400 for unknown client when clients are configured", async () => {
      const res = await app.request(
        `${base}/authorize?client_id=unknown&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Application not found");
    });

    it("returns 400 for redirect URI mismatch", async () => {
      const res = await app.request(
        `${base}/authorize?client_id=auth0-test-client&redirect_uri=${encodeURIComponent("http://evil.test/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Redirect URI mismatch");
    });

    it("returns 400 for unknown audience", async () => {
      const res = await app.request(
        `${base}/authorize?client_id=auth0-test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&audience=${encodeURIComponent("https://missing.test/")}`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Unknown audience");
    });

    it("returns form_post response mode", async () => {
      const { code, state } = await getAuthCode(app, store, { responseMode: "form_post" });
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");
    });
  });

  describe("OAuth flows", () => {
    it("completes authorization_code flow", async () => {
      const { code, state } = await getAuthCode(app, store);
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");

      const tokenRes = await exchangeCode(app, code);
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      expect((body.access_token as string).startsWith("auth0_")).toBe(true);
      expect((body.refresh_token as string).startsWith("r_auth0_")).toBe(true);
      expect(body.token_type).toBe("Bearer");
      expect(body.id_token).toBeDefined();

      const claims = decodeJwt(body.id_token as string);
      expect(claims.iss).toBe(`${base}/?tenant=acme`);
      expect(claims.aud).toBe("auth0-test-client");
      expect(claims.sub).toContain("|");
      expect(claims.nonce).toBe("nonce-1");
      expect(claims.email).toBe("alice@example.com");
    });

    it("includes organization claims in ID token", async () => {
      const { code } = await getAuthCode(app, store, { organization: "org_acme" });
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      const claims = decodeJwt(body.id_token as string);
      expect(claims.org_id).toBe("org_acme");
      expect(claims.org_name).toBe("acme");
    });

    it("stores access tokens for userinfo", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;

      const userinfo = await app.request(`${base}/userinfo`, {
        headers: { Authorization: `Bearer ${body.access_token}` },
      });
      expect(userinfo.status).toBe(200);
      const info = (await userinfo.json()) as Record<string, unknown>;
      expect(info.email).toBe("alice@example.com");
      expect(info.name).toBe("Alice Example");
    });

    it("refreshes and rotates refresh tokens", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      const refreshToken = body.refresh_token as string;

      const refreshRes = await app.request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "auth0-test-client",
          client_secret: "auth0-test-secret",
        }).toString(),
      });
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as Record<string, unknown>;
      expect((refreshBody.access_token as string).startsWith("auth0_")).toBe(true);
      expect(refreshBody.refresh_token).not.toBe(refreshToken);
    });

    it("rejects second refresh token use after rotation", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code);
      const body = (await tokenRes.json()) as Record<string, unknown>;
      const refreshToken = body.refresh_token as string;
      const params = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "auth0-test-client",
        client_secret: "auth0-test-secret",
      };
      const first = await app.request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      expect(first.status).toBe(200);
      const second = await app.request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      expect(second.status).toBe(400);
    });

    it("rejects second use of authorization code", async () => {
      const { code } = await getAuthCode(app, store);
      expect((await exchangeCode(app, code)).status).toBe(200);
      const second = await exchangeCode(app, code);
      expect(second.status).toBe(400);
    });

    it("supports client_credentials grant", async () => {
      const res = await app.request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: "auth0-test-client",
          client_secret: "auth0-test-secret",
          audience: "https://api.example.test/",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.access_token as string).startsWith("auth0_")).toBe(true);
      expect(body.refresh_token).toBeUndefined();
    });

    it("supports Basic client authentication", async () => {
      const { code } = await getAuthCode(app, store);
      const tokenRes = await exchangeCode(app, code, { useBasicAuth: true });
      expect(tokenRes.status).toBe(200);
    });

    it("rejects unsupported grant type", async () => {
      const res = await app.request(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "auth0-test-client",
          client_secret: "auth0-test-secret",
        }).toString(),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).error).toBe("unsupported_grant_type");
    });
  });

  describe("PKCE", () => {
    it("supports S256 code challenge", async () => {
      const verifier = "pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, { codeChallenge: challenge, codeChallengeMethod: "S256" });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
    });

    it("supports plain code challenge", async () => {
      const verifier = "plain-verifier";
      const { code } = await getAuthCode(app, store, { codeChallenge: verifier, codeChallengeMethod: "plain" });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
    });

    it("rejects incorrect verifier", async () => {
      const verifier = "pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, { codeChallenge: challenge, codeChallengeMethod: "S256" });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: "wrong-verifier" });
      expect(tokenRes.status).toBe(400);
    });

    it("supports public clients without client_secret", async () => {
      const verifier = "public-pkce-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { code } = await getAuthCode(app, store, {
        clientId: "public-client",
        redirectUri: "http://localhost:3000/public-callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, {
        clientId: "public-client",
        redirectUri: "http://localhost:3000/public-callback",
        codeVerifier: verifier,
        includeClientSecret: false,
      });
      expect(tokenRes.status).toBe(200);
    });
  });

  describe("Management API", () => {
    it("requires management authentication", async () => {
      const res = await app.request(`${base}/api/v2/users`);
      expect(res.status).toBe(401);
    });

    it("lists and reads users", async () => {
      const list = await app.request(`${base}/api/v2/users`, { headers: managementHeaders() });
      expect(list.status).toBe(200);
      const users = (await list.json()) as Array<Record<string, unknown>>;
      expect(users.some((user) => user.email === "alice@example.com")).toBe(true);

      const one = await app.request(`${base}/api/v2/users/${encodeURIComponent(users[0]!.user_id as string)}`, {
        headers: managementHeaders(),
      });
      expect(one.status).toBe(200);
    });

    it("creates, updates, and deletes users", async () => {
      const created = await app.request(`${base}/api/v2/users`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ email: "bob@example.com", name: "Bob Example", password: "pass" }),
      });
      expect(created.status).toBe(201);
      const user = (await created.json()) as Record<string, unknown>;

      const updated = await app.request(`${base}/api/v2/users/${encodeURIComponent(user.user_id as string)}`, {
        method: "PATCH",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "Bob Updated", email_verified: true }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Record<string, unknown>).name).toBe("Bob Updated");

      const deleted = await app.request(`${base}/api/v2/users/${encodeURIComponent(user.user_id as string)}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(deleted.status).toBe(204);
    });

    it("creates, updates, and deletes roles", async () => {
      const created = await app.request(`${base}/api/v2/roles`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "editor", description: "Editor" }),
      });
      expect(created.status).toBe(201);
      const role = (await created.json()) as Record<string, unknown>;
      const updated = await app.request(`${base}/api/v2/roles/${role.id}`, {
        method: "PATCH",
        headers: managementHeaders(),
        body: JSON.stringify({ description: "Updated" }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Record<string, unknown>).description).toBe("Updated");
      expect(
        (
          await app.request(`${base}/api/v2/roles/${role.id}`, {
            method: "DELETE",
            headers: managementHeaders(),
          })
        ).status,
      ).toBe(204);
    });

    it("assigns roles to users", async () => {
      const auth0 = getAuth0Store(store);
      const user = auth0.users.findOneBy("email", "alice@example.com")!;
      const res = await app.request(`${base}/api/v2/users/${encodeURIComponent(user.auth0_id)}/roles`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ roles: ["rol_admin"] }),
      });
      expect(res.status).toBe(204);
      const roles = await app.request(`${base}/api/v2/users/${encodeURIComponent(user.auth0_id)}/roles`, {
        headers: managementHeaders(),
      });
      const body = (await roles.json()) as Array<Record<string, unknown>>;
      expect(body.some((role) => role.name === "admin")).toBe(true);
    });

    it("creates, updates, and deletes applications", async () => {
      const created = await app.request(`${base}/api/v2/applications`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "New App", callbacks: ["http://localhost:3000/new"] }),
      });
      expect(created.status).toBe(201);
      const appBody = (await created.json()) as Record<string, unknown>;
      const updated = await app.request(`${base}/api/v2/applications/${appBody.client_id}`, {
        method: "PATCH",
        headers: managementHeaders(),
        body: JSON.stringify({ callbacks: ["http://localhost:3000/updated"] }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Record<string, unknown>).callbacks).toEqual(["http://localhost:3000/updated"]);
      const deleted = await app.request(`${base}/api/v2/applications/${appBody.client_id}`, {
        method: "DELETE",
        headers: managementHeaders(),
      });
      expect(deleted.status).toBe(204);
    });

    it("creates, updates, and deletes connections", async () => {
      const created = await app.request(`${base}/api/v2/connections`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "github", strategy: "github" }),
      });
      expect(created.status).toBe(201);
      const connection = (await created.json()) as Record<string, unknown>;
      const updated = await app.request(`${base}/api/v2/connections/${connection.id}`, {
        method: "PATCH",
        headers: managementHeaders(),
        body: JSON.stringify({ enabled_clients: ["auth0-test-client"] }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Record<string, unknown>).enabled_clients).toEqual(["auth0-test-client"]);
      expect(
        (
          await app.request(`${base}/api/v2/connections/${connection.id}`, {
            method: "DELETE",
            headers: managementHeaders(),
          })
        ).status,
      ).toBe(204);
    });

    it("creates, updates, and deletes organizations", async () => {
      const created = await app.request(`${base}/api/v2/organizations`, {
        method: "POST",
        headers: managementHeaders(),
        body: JSON.stringify({ name: "new-org", display_name: "New Org" }),
      });
      expect(created.status).toBe(201);
      const org = (await created.json()) as Record<string, unknown>;
      const updated = await app.request(`${base}/api/v2/organizations/${org.id}`, {
        method: "PATCH",
        headers: managementHeaders(),
        body: JSON.stringify({ display_name: "Updated Org" }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as Record<string, unknown>).display_name).toBe("Updated Org");
      expect(
        (
          await app.request(`${base}/api/v2/organizations/${org.id}`, {
            method: "DELETE",
            headers: managementHeaders(),
          })
        ).status,
      ).toBe(204);
    });

    it("lists organization members", async () => {
      const res = await app.request(`${base}/api/v2/organizations/org_acme/members`, { headers: managementHeaders() });
      expect(res.status).toBe(200);
      const members = (await res.json()) as Array<Record<string, unknown>>;
      expect(members.some((member) => member.email === "alice@example.com")).toBe(true);
    });
  });

  describe("logout", () => {
    it("clears session cookies and redirects", async () => {
      const res = await app.request(`${base}/v2/logout?returnTo=${encodeURIComponent("http://localhost:3000/")}`, {
        headers: { Cookie: "auth0_session=abc; sid=def" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3000/");
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });
});
