import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { vercelPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  vercelPlugin.register(app as any, store, webhooks, base, tokenMap);
  vercelPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
    integrations: [
      {
        client_id: "emu_device_client",
        client_secret: "device-secret",
        name: "Device App",
        redirect_uris: ["http://localhost:3000/callback"],
      },
    ],
  });

  return { app, store, tokenMap };
}

async function deviceCode(app: Hono): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}> {
  const res = await app.request(`${base}/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "emu_device_client", scope: "openid email" }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof deviceCode>>;
}

function poll(app: Hono, code: string) {
  return app.request(`${base}/login/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "emu_device_client",
      device_code: code,
    }).toString(),
  });
}

describe("Vercel device authorization grant", () => {
  let app: Hono;
  let tokenMap: TokenMap;

  beforeEach(() => {
    ({ app, tokenMap } = createTestApp());
  });

  it("documents the endpoints in its OpenID configuration", async () => {
    const res = await app.request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_authorization_endpoint: string;
      token_endpoint: string;
      grant_types_supported: string[];
    };
    expect(body.device_authorization_endpoint).toBe(`${base}/oauth/device_authorization`);
    expect(body.token_endpoint).toBe(`${base}/login/oauth/token`);
    expect(body.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("starts a grant and answers authorization_pending until it is approved", async () => {
    const started = await deviceCode(app);
    expect(started.device_code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(started.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verification_uri).toBe(`${base}/oauth/device`);
    expect(started.verification_uri_complete).toContain(encodeURIComponent(started.user_code));
    expect(started.expires_in).toBeGreaterThan(0);
    expect(started.interval).toBeGreaterThan(0);

    const pending = await poll(app, started.device_code);
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");

    const quickly = await poll(app, started.device_code);
    expect(quickly.status).toBe(429);
    expect(((await quickly.json()) as { error: string }).error).toBe("slow_down");

    const page = await app.request(`${base}/oauth/device?user_code=${encodeURIComponent(started.user_code)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("developer");

    const approved = await app.request(`${base}/oauth/device/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "developer", user_code: started.user_code }).toString(),
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("Device connected");

    const exchanged = await poll(app, started.device_code);
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json()) as { access_token: string; token_type: string; scope: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("openid email");
    expect(tokenMap.has(token.access_token)).toBe(true);

    const info = await app.request(`${base}/login/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    expect(info.status).toBe(200);
    expect(((await info.json()) as { preferred_username: string }).preferred_username).toBe("developer");

    const again = await poll(app, started.device_code);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("answers a denial and an unknown code", async () => {
    const started = await deviceCode(app);
    await app.request(`${base}/oauth/device/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "developer", user_code: started.user_code, decision: "deny" }).toString(),
    });
    const denied = await poll(app, started.device_code);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("access_denied");

    const unknown = await poll(app, "not-a-device-code");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects an unregistered client", async () => {
    const res = await app.request(`${base}/oauth/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "unknown" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
});
