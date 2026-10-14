import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync, sign } from "crypto";
import { Hono } from "../http.js";
import {
  authMiddleware,
  requireAuth,
  requireAppAuth,
  restoreTokenMap,
  serializeTokenMap,
  type TokenMap,
  type AppEnv,
} from "../middleware/auth.js";

describe("authMiddleware", () => {
  let tokenMap: TokenMap;

  beforeEach(() => {
    tokenMap = new Map();
  });

  it("sets authUser on context when the token exists in tokenMap", async () => {
    tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["repo"] });

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.get("/test", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string; id: number; scopes: string[] } };
    expect(body.user).toEqual({ login: "testuser", id: 1, scopes: ["repo"] });
  });

  it("maps unknown tokens to fallbackUser when configured", async () => {
    const fallbackUser = { login: "fallback", id: 99, scopes: ["read:org"] };

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap, undefined, fallbackUser));
    app.get("/test", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer unknown-secret" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string; id: number; scopes: string[] } };
    expect(body.user).toEqual(fallbackUser);
    expect(tokenMap.has("unknown-secret")).toBe(false);
  });

  it("reads a token from the request when there is no Authorization header", async () => {
    tokenMap.set("query-token", { login: "testuser", id: 1, scopes: ["repo"] });
    const fallbackUser = { login: "fallback", id: 99, scopes: [] };

    const app = new Hono<AppEnv>();
    app.use(
      "*",
      authMiddleware(tokenMap, undefined, fallbackUser, (c) => c.req.query("token")),
    );
    app.get("/test", (c) => c.json({ user: c.get("authUser") ?? null, token: c.get("authToken") ?? null }));

    const known = (await (await app.request("/test?token=query-token")).json()) as any;
    expect(known).toEqual({ user: { login: "testuser", id: 1, scopes: ["repo"] }, token: "query-token" });

    // The same fallback applies as for a header token.
    const unknown = (await (await app.request("/test?token=other")).json()) as any;
    expect(unknown.user).toEqual(fallbackUser);

    expect(((await (await app.request("/test")).json()) as any).user).toBeNull();
  });

  it("prefers the Authorization header over a token read from the request", async () => {
    tokenMap.set("header-token", { login: "header", id: 1, scopes: [] });
    tokenMap.set("query-token", { login: "query", id: 2, scopes: [] });
    let reads = 0;

    const app = new Hono<AppEnv>();
    app.use(
      "*",
      authMiddleware(tokenMap, undefined, undefined, (c) => {
        reads++;
        return c.req.query("token");
      }),
    );
    app.get("/test", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/test?token=query-token", { headers: { Authorization: "Bearer header-token" } });
    expect(((await res.json()) as any).user.login).toBe("header");
    expect(reads).toBe(0);
  });

  it("does not set authUser when there is no Authorization header", async () => {
    tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["repo"] });

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.get("/test", (c) => c.json({ user: c.get("authUser") ?? null }));

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });

  it("preserves installation credentials when token maps are serialized", () => {
    tokenMap.set("installation-token", {
      login: "acme",
      id: 7,
      scopes: ["contents:write"],
      installation: {
        installationId: 42,
        appId: 9,
        accountId: 7,
        accountType: "Organization",
        permissions: { contents: "write" },
        repositoryIds: [12],
        repositorySelection: "selected",
      },
    });

    const restored: TokenMap = new Map();
    restoreTokenMap(restored, serializeTokenMap(tokenMap));
    expect(restored.get("installation-token")).toEqual(tokenMap.get("installation-token"));
  });

  it.each(["pkcs8", "pkcs1"] as const)("sets authApp for a valid GitHub App JWT signed with %s", async (format) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: format, format: "pem" }).toString();
    const jwt = createAppJwt("42", privateKeyPem);

    const app = new Hono<AppEnv>();
    app.use(
      "*",
      authMiddleware(tokenMap, (appId) => {
        if (appId !== 42) return null;
        return { privateKey: privateKeyPem, slug: "my-app", name: "My App" };
      }),
    );
    app.get("/test", (c) => c.json({ app: c.get("authApp") }));

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { appId: number; slug: string; name: string } };
    expect(body.app).toEqual({ appId: 42, slug: "my-app", name: "My App" });
  });
});

describe("requireAuth", () => {
  let tokenMap: TokenMap;

  beforeEach(() => {
    tokenMap = new Map();
    tokenMap.set("ok-token", { login: "alice", id: 1, scopes: [] });
  });

  it("returns 401 when authUser is not set", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.use("*", requireAuth());
    app.get("/protected", (c) => c.json({ ok: true }));

    const res = await app.request("/protected");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string; documentation_url: string };
    expect(body.message).toBe("Requires authentication");
    expect(body.documentation_url).toBe("https://emulate.dev");
  });

  it("passes through when authUser exists", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.use("*", requireAuth());
    app.get("/protected", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer ok-token" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string } };
    expect(body.user?.login).toBe("alice");
  });
});

function createAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("requireAppAuth", () => {
  it("returns 401 when authApp is not set", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", requireAppAuth());
    app.get("/app-route", (c) => c.json({ ok: true }));

    const res = await app.request("/app-route");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string; documentation_url: string };
    expect(body.message).toBe("A JSON web token could not be decoded");
    expect(body.documentation_url).toBe("https://emulate.dev");
  });

  it("passes through when authApp exists", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("authApp", { appId: 42, slug: "my-app", name: "My App" });
      await next();
    });
    app.use("*", requireAppAuth());
    app.get("/app-route", (c) => c.json({ app: c.get("authApp") }));

    const res = await app.request("/app-route");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { appId: number; slug: string; name: string };
    };
    expect(body.app).toEqual({ appId: 42, slug: "my-app", name: "My App" });
  });
});
