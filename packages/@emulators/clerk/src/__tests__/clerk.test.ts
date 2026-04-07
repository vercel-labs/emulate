import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getClerkStore, clerkPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4200";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("sk_test_emulate", { login: "admin", id: 1, scopes: [] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  clerkPlugin.register(app as any, store, webhooks, base, tokenMap);
  clerkPlugin.seed?.(store, base);
  return { app, store, tokenMap };
}

function createSeededApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("sk_test_emulate", { login: "admin", id: 1, scopes: [] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  clerkPlugin.register(app as any, store, webhooks, base, tokenMap);
  clerkPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { email_addresses: ["alice@example.com"], first_name: "Alice", last_name: "Smith", password: "alice123" },
      { email_addresses: ["bob@example.com"], first_name: "Bob", last_name: "Jones" },
    ],
    organizations: [
      {
        name: "Acme Corp",
        slug: "acme",
        members: [
          { email: "alice@example.com", role: "admin" },
          { email: "bob@example.com", role: "member" },
        ],
      },
    ],
    oauth_applications: [
      {
        client_id: "test-client",
        client_secret: "test-secret",
        name: "Test App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
  });
  return { app, store, tokenMap };
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer sk_test_emulate",
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
    codeChallenge?: string;
    codeChallengeMethod?: string;
  } = {},
): Promise<{ code: string; state: string; response: Response }> {
  const cs = getClerkStore(store);
  const userRef = options.userRef ?? cs.users.all()[0]?.clerk_id ?? "";
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const clientId = options.clientId ?? "test-client";
  const scope = options.scope ?? "openid profile email";
  const state = options.state ?? "state-1";
  const nonce = options.nonce ?? "nonce-1";

  const formData = new URLSearchParams({
    user_ref: userRef,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    client_id: clientId,
    code_challenge: options.codeChallenge ?? "",
    code_challenge_method: options.codeChallengeMethod ?? "",
  });

  const response = await app.request(`${base}/oauth/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

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
    redirectUri?: string;
    codeVerifier?: string;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.clientId ?? "test-client",
    client_secret: options.clientSecret ?? "test-secret",
    redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
  });
  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  return app.request(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("Clerk plugin integration", () => {
  let app: Hono;
  let store: Store;
  let tokenMap: TokenMap;

  beforeEach(() => {
    const setup = createSeededApp();
    app = setup.app;
    store = setup.store;
    tokenMap = setup.tokenMap;
  });

  describe("OIDC discovery and JWKS", () => {
    it("returns discovery document", async () => {
      const res = await app.request(`${base}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.issuer).toBe(base);
      expect(body.authorization_endpoint).toBe(`${base}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${base}/oauth/token`);
      expect(body.jwks_uri).toBe(`${base}/v1/jwks`);
      expect(body.userinfo_endpoint).toBe(`${base}/oauth/userinfo`);
      expect(body.code_challenge_methods_supported).toEqual(["plain", "S256"]);
      expect((body.claims_supported as string[])).toContain("org_id");
      expect((body.claims_supported as string[])).toContain("sid");
    });

    it("returns JWKS with RS256 key", async () => {
      const res = await app.request(`${base}/v1/jwks`);
      expect(res.status).toBe(200);
      const body = await res.json() as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kty).toBe("RSA");
      expect(body.keys[0].kid).toBe("emulate-clerk-1");
      expect(body.keys[0].alg).toBe("RS256");
      expect(body.keys[0].use).toBe("sig");
    });
  });

  describe("OAuth authorization flow", () => {
    it("returns sign-in HTML page", async () => {
      const res = await app.request(
        `${base}/oauth/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain("Clerk");
    });

    it("rejects unknown client_id", async () => {
      const res = await app.request(
        `${base}/oauth/authorize?client_id=unknown&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code`,
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Application not found");
    });

    it("completes authorization_code flow", async () => {
      const { code, state } = await getAuthCode(app, store);
      expect(code).toBeTruthy();
      expect(state).toBe("state-1");

      const tokenRes = await exchangeCode(app, code);
      expect(tokenRes.status).toBe(200);
      const body = await tokenRes.json() as Record<string, unknown>;
      expect((body.access_token as string).startsWith("clerk_")).toBe(true);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3600);
      expect(body.id_token).toBeDefined();

      const claims = decodeJwt(body.id_token as string);
      expect(claims.iss).toBe(base);
      expect(claims.sub).toMatch(/^user_/);
      expect(claims.sid).toMatch(/^sess_/);
    });

    it("rejects second use of authorization code", async () => {
      const { code } = await getAuthCode(app, store);
      const first = await exchangeCode(app, code);
      expect(first.status).toBe(200);
      const second = await exchangeCode(app, code);
      expect(second.status).toBe(400);
      const body = await second.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_grant");
    });

    it("rejects wrong client secret", async () => {
      const { code } = await getAuthCode(app, store);
      const res = await exchangeCode(app, code, { clientSecret: "wrong" });
      expect(res.status).toBe(401);
    });
  });

  describe("PKCE", () => {
    it("supports S256 code challenge", async () => {
      const verifier = "pkce-test-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: verifier });
      expect(tokenRes.status).toBe(200);
    });

    it("rejects incorrect S256 verifier", async () => {
      const verifier = "pkce-test-verifier-12345";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      const { code } = await getAuthCode(app, store, {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      const tokenRes = await exchangeCode(app, code, { codeVerifier: "wrong" });
      expect(tokenRes.status).toBe(400);
    });
  });

  describe("authentication", () => {
    it("rejects requests without auth", async () => {
      const res = await app.request(`${base}/v1/users`);
      expect(res.status).toBe(401);
      const body = await res.json() as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("UNAUTHORIZED");
    });

    it("rejects invalid bearer tokens", async () => {
      const res = await app.request(`${base}/v1/users`, {
        headers: { Authorization: "Bearer invalid_token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("users API", () => {
    it("lists users with pagination", async () => {
      const res = await app.request(`${base}/v1/users`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; total_count: number; has_more: boolean };
      expect(body.total_count).toBeGreaterThanOrEqual(3);
      expect(body.has_more).toBe(false);
      expect(body.data.length).toBeGreaterThanOrEqual(3);
    });

    it("lists users with limit and offset", async () => {
      const res = await app.request(`${base}/v1/users?limit=1&offset=0`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; total_count: number; has_more: boolean };
      expect(body.data).toHaveLength(1);
      expect(body.has_more).toBe(true);
    });

    it("filters users by query", async () => {
      const res = await app.request(`${base}/v1/users?query=alice`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<{ first_name: string }>; total_count: number };
      expect(body.total_count).toBe(1);
      expect(body.data[0].first_name).toBe("Alice");
    });

    it("filters users by email_address", async () => {
      const res = await app.request(`${base}/v1/users?email_address=bob@example.com`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<{ first_name: string }>; total_count: number };
      expect(body.total_count).toBe(1);
      expect(body.data[0].first_name).toBe("Bob");
    });

    it("creates a user", async () => {
      const res = await app.request(`${base}/v1/users`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email_address: ["new@example.com"],
          first_name: "New",
          last_name: "User",
          password: "secret",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("user");
      expect((body.id as string)).toMatch(/^user_/);
      expect(body.first_name).toBe("New");
      expect(body.password_enabled).toBe(true);
      expect((body.email_addresses as Array<{ email_address: string }>)[0].email_address).toBe("new@example.com");
    });

    it("gets a user by ID", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/users/${user.clerk_id}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.first_name).toBe("Alice");
    });

    it("returns 404 for unknown user", async () => {
      const res = await app.request(`${base}/v1/users/user_nonexistent`, { headers: authHeaders() });
      expect(res.status).toBe(404);
    });

    it("updates a user", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/users/${user.clerk_id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ first_name: "Alicia" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.first_name).toBe("Alicia");
    });

    it("deletes a user", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Bob")!;
      const res = await app.request(`${base}/v1/users/${user.clerk_id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("deleted_object");
      expect(body.deleted).toBe(true);
    });

    it("bans and unbans a user", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;

      const banRes = await app.request(`${base}/v1/users/${user.clerk_id}/ban`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(banRes.status).toBe(200);
      expect((await banRes.json() as Record<string, unknown>).banned).toBe(true);

      const unbanRes = await app.request(`${base}/v1/users/${user.clerk_id}/unban`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(unbanRes.status).toBe(200);
      expect((await unbanRes.json() as Record<string, unknown>).banned).toBe(false);
    });

    it("locks and unlocks a user", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;

      const lockRes = await app.request(`${base}/v1/users/${user.clerk_id}/lock`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(lockRes.status).toBe(200);
      expect((await lockRes.json() as Record<string, unknown>).locked).toBe(true);

      const unlockRes = await app.request(`${base}/v1/users/${user.clerk_id}/unlock`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(unlockRes.status).toBe(200);
      expect((await unlockRes.json() as Record<string, unknown>).locked).toBe(false);
    });

    it("updates metadata (merge)", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;

      await app.request(`${base}/v1/users/${user.clerk_id}/metadata`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ public_metadata: { plan: "pro" } }),
      });

      const res = await app.request(`${base}/v1/users/${user.clerk_id}/metadata`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ public_metadata: { role: "admin" } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const meta = body.public_metadata as Record<string, unknown>;
      expect(meta.plan).toBe("pro");
      expect(meta.role).toBe("admin");
    });

    it("returns user count", async () => {
      const res = await app.request(`${base}/v1/users/count`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { total_count: number };
      expect(body.total_count).toBeGreaterThanOrEqual(3);
    });

    it("verifies correct password", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/users/${user.clerk_id}/verify_password`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ password: "alice123" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { verified: boolean };
      expect(body.verified).toBe(true);
    });

    it("rejects wrong password", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/users/${user.clerk_id}/verify_password`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { verified: boolean };
      expect(body.verified).toBe(false);
    });
  });

  describe("email addresses API", () => {
    it("creates an email address", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/email_addresses`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          user_id: user.clerk_id,
          email_address: "alice2@example.com",
          verified: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("email_address");
      expect(body.email_address).toBe("alice2@example.com");
      expect((body.verification as Record<string, unknown>).status).toBe("verified");
    });

    it("gets an email address", async () => {
      const cs = getClerkStore(store);
      const email = cs.emailAddresses.all().find((e) => e.email_address === "alice@example.com")!;
      const res = await app.request(`${base}/v1/email_addresses/${email.email_id}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.email_address).toBe("alice@example.com");
    });

    it("deletes an email address", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all().find((u) => u.first_name === "Alice")!;

      const createRes = await app.request(`${base}/v1/email_addresses`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id, email_address: "delete-me@example.com" }),
      });
      const created = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/email_addresses/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("deleted_object");
      expect(body.deleted).toBe(true);
    });
  });

  describe("organizations API", () => {
    it("lists organizations", async () => {
      const res = await app.request(`${base}/v1/organizations`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>>; total_count: number };
      expect(body.total_count).toBeGreaterThanOrEqual(1);
      const acme = body.data.find((o) => o.slug === "acme");
      expect(acme).toBeDefined();
      expect(acme!.name).toBe("Acme Corp");
    });

    it("gets organization by ID", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.name).toBe("Acme Corp");
    });

    it("gets organization by slug", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const res = await app.request(`${base}/v1/organizations/acme`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe(org.clerk_id);
    });

    it("creates an organization", async () => {
      const res = await app.request(`${base}/v1/organizations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "New Org", slug: "new-org" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("organization");
      expect(body.name).toBe("New Org");
      expect(body.slug).toBe("new-org");
      expect((body.id as string)).toMatch(/^org_/);
    });

    it("updates an organization", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Acme Inc" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.name).toBe("Acme Inc");
    });

    it("deletes an organization", async () => {
      const createRes = await app.request(`${base}/v1/organizations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Delete Me" }),
      });
      const created = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/organizations/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.deleted).toBe(true);
    });
  });

  describe("memberships API", () => {
    it("lists organization memberships", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/memberships`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>>; total_count: number };
      expect(body.total_count).toBe(2);
    });

    it("adds a member to organization", async () => {
      const cs = getClerkStore(store);

      const createRes = await app.request(`${base}/v1/organizations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Membership Test", slug: "membership-test" }),
      });
      const org = await createRes.json() as Record<string, unknown>;

      const user = cs.users.all().find((u) => u.first_name === "Alice")!;
      const res = await app.request(`${base}/v1/organizations/${org.id}/memberships`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id, role: "org:admin" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.role).toBe("org:admin");
    });

    it("updates membership role", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const bobUser = cs.users.all().find((u) => u.first_name === "Bob")!;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/memberships/${bobUser.clerk_id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ role: "org:admin" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.role).toBe("org:admin");
    });

    it("removes a member", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const bobUser = cs.users.all().find((u) => u.first_name === "Bob")!;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/memberships/${bobUser.clerk_id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.deleted).toBe(true);
    });

    it("rejects duplicate membership", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;
      const aliceUser = cs.users.all().find((u) => u.first_name === "Alice")!;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/memberships`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: aliceUser.clerk_id, role: "org:member" }),
      });
      expect(res.status).toBe(422);
      const body = await res.json() as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("DUPLICATE_RECORD");
    });
  });

  describe("invitations API", () => {
    it("creates an invitation", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ email_address: "invite@example.com", role: "org:member" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("organization_invitation");
      expect(body.email_address).toBe("invite@example.com");
      expect(body.status).toBe("pending");
    });

    it("lists invitations with status filter", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;

      await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ email_address: "inv1@example.com" }),
      });

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations?status=pending`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; total_count: number };
      expect(body.total_count).toBeGreaterThanOrEqual(1);
    });

    it("revokes an invitation", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;

      const createRes = await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ email_address: "revoke@example.com" }),
      });
      const invitation = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations/${invitation.id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("revoked");
    });

    it("bulk creates invitations", async () => {
      const cs = getClerkStore(store);
      const org = cs.organizations.findOneBy("slug", "acme")!;

      const res = await app.request(`${base}/v1/organizations/${org.clerk_id}/invitations/bulk`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          email_addresses: ["bulk1@example.com", "bulk2@example.com"],
          role: "org:member",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(body).toHaveLength(2);
    });
  });

  describe("sessions API", () => {
    it("creates a session", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all()[0];

      const res = await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.object).toBe("session");
      expect((body.id as string)).toMatch(/^sess_/);
      expect(body.status).toBe("active");
      expect(body.user_id).toBe(user.clerk_id);
    });

    it("lists sessions", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all()[0];

      await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id }),
      });

      const res = await app.request(`${base}/v1/sessions`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[]; total_count: number };
      expect(body.total_count).toBeGreaterThanOrEqual(1);
    });

    it("revokes a session", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all()[0];

      const createRes = await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id }),
      });
      const session = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/sessions/${session.id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("revoked");
    });

    it("generates a JWT token", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all()[0];

      const createRes = await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id }),
      });
      const session = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/sessions/${session.id}/tokens`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { object: string; jwt: string };
      expect(body.object).toBe("token");
      expect(body.jwt).toBeTruthy();

      const claims = decodeJwt(body.jwt);
      expect(claims.iss).toBe(base);
      expect(claims.sub).toBe(user.clerk_id);
      expect(claims.sid).toBe(session.id);
      expect(claims.exp).toBeDefined();
      expect(claims.nbf).toBeDefined();
    });

    it("includes org claims in JWT when user has membership", async () => {
      const cs = getClerkStore(store);
      const aliceUser = cs.users.all().find((u) => u.first_name === "Alice")!;

      const createRes = await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: aliceUser.clerk_id }),
      });
      const session = await createRes.json() as Record<string, unknown>;

      const res = await app.request(`${base}/v1/sessions/${session.id}/tokens`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = await res.json() as { jwt: string };
      const claims = decodeJwt(body.jwt);
      expect(claims.org_id).toMatch(/^org_/);
      expect(claims.org_role).toBe("org:admin");
      expect(claims.org_slug).toBe("acme");
    });

    it("rejects token generation for revoked session", async () => {
      const cs = getClerkStore(store);
      const user = cs.users.all()[0];

      const createRes = await app.request(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ user_id: user.clerk_id }),
      });
      const session = await createRes.json() as Record<string, unknown>;

      await app.request(`${base}/v1/sessions/${session.id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
      });

      const res = await app.request(`${base}/v1/sessions/${session.id}/tokens`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("seed config", () => {
    it("seeds users with email addresses", () => {
      const cs = getClerkStore(store);
      const alice = cs.users.all().find((u) => u.first_name === "Alice");
      expect(alice).toBeDefined();
      const emails = cs.emailAddresses.findBy("user_id", alice!.clerk_id);
      expect(emails.length).toBeGreaterThanOrEqual(1);
      expect(emails[0].email_address).toBe("alice@example.com");
      expect(emails[0].is_primary).toBe(true);
    });

    it("seeds organizations with members", () => {
      const cs = getClerkStore(store);
      const acme = cs.organizations.findOneBy("slug", "acme");
      expect(acme).toBeDefined();
      expect(acme!.members_count).toBe(2);

      const memberships = cs.memberships.findBy("org_id", acme!.clerk_id);
      expect(memberships).toHaveLength(2);
      const adminMembership = memberships.find((m) => m.role === "org:admin");
      expect(adminMembership).toBeDefined();
    });

    it("seeds oauth applications", () => {
      const cs = getClerkStore(store);
      const oauthApp = cs.oauthApps.findOneBy("client_id", "test-client");
      expect(oauthApp).toBeDefined();
      expect(oauthApp!.name).toBe("Test App");
      expect(oauthApp!.redirect_uris).toContain("http://localhost:3000/callback");
    });

    it("does not duplicate on re-seed", () => {
      const cs = getClerkStore(store);
      const countBefore = cs.users.all().length;
      seedFromConfig(store, base, {
        users: [{ email_addresses: ["alice@example.com"], first_name: "Alice" }],
      });
      expect(cs.users.all().length).toBe(countBefore);
    });
  });

  describe("error format", () => {
    it("returns Clerk error format", async () => {
      const res = await app.request(`${base}/v1/users/user_nonexistent`, { headers: authHeaders() });
      expect(res.status).toBe(404);
      const body = await res.json() as { errors: Array<{ code: string; message: string; long_message: string; meta: unknown }> };
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].code).toBe("RESOURCE_NOT_FOUND");
      expect(body.errors[0].message).toBeDefined();
      expect(body.errors[0].long_message).toBeDefined();
      expect(body.errors[0].meta).toBeDefined();
    });
  });
});
