import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const resourcePaths = [
  "/drive/v3/files",
  "/gmail/v1/users/me/messages",
  "/calendar/v3/calendars/primary/events",
  "/oauth2/v2/userinfo",
];
const client = { client_id: "google-client", client_secret: "google-secret" };
const redirectUri = "http://localhost/callback";

function fixture(strict?: boolean, sharedTokens = true) {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  const fallback = { login: "alice@example.com", id: 2, scopes: [scope("drive")] };
  tokens.set("development-token", fallback);
  app.use("*", authMiddleware(tokens, undefined, fallback));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, sharedTokens ? tokens : undefined);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    ...(strict === undefined ? {} : { strict_scopes: strict }),
    users: [{ email: fallback.login, name: "Alice Example" }],
    oauth_clients: [{ ...client, redirect_uris: [redirectUri] }],
    drive_items: [{ id: "file", user_email: fallback.login, name: "Notes", mime_type: "text/plain", data: "notes" }],
    messages: [
      {
        id: "message",
        user_email: fallback.login,
        from: "bob@example.com",
        to: fallback.login,
        body_text: "Hello",
        label_ids: ["INBOX"],
      },
    ],
    calendars: [{ id: "primary", user_email: fallback.login, summary: "Alice", primary: true }],
  });

  function request(path: string, token?: string, method = "GET", body?: unknown) {
    return app.request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function form(path: string, body: Record<string, string>) {
    return app.request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  async function grant(scopes: string) {
    const authorize = await form("/o/oauth2/v2/auth/callback", {
      email: fallback.login,
      redirect_uri: redirectUri,
      scope: scopes,
      client_id: client.client_id,
    });
    expect(authorize.status).toBe(302);
    const code = new URL(authorize.headers.get("Location")!).searchParams.get("code")!;
    const exchange = await form("/oauth2/token", {
      ...client,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    expect(exchange.status).toBe(200);
    return (await exchange.json()) as { access_token: string; refresh_token: string; id_token: string; scope: string };
  }

  const refresh = (token: string) =>
    form("/oauth2/token", { ...client, grant_type: "refresh_token", refresh_token: token });
  const revoke = (token: string) => form("/oauth2/revoke", { token });
  return { app, store, request, grant, refresh, revoke };
}

afterEach(() => vi.restoreAllMocks());

describe("Google strict OAuth authentication", () => {
  it("rejects missing, unknown, development, refresh, and ID tokens with Google errors", async () => {
    const { grant, request } = fixture(true);
    const issued = await grant("openid");
    for (const token of [undefined, "unknown", "development-token", issued.refresh_token, issued.id_token]) {
      for (const path of resourcePaths) {
        const response = await request(path, token);
        expect(response.status, `${path}: ${token?.slice(0, 20)}`).toBe(401);
        expect(await response.json()).toMatchObject({
          error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError", domain: "global" }] },
        });
      }
    }
  });

  it("allows granted scopes and refuses an unrelated scope family", async () => {
    const { grant, request } = fixture(true);
    for (const [path, scopes] of resourcePaths.map((path, i) => [
      path,
      [scope("drive.readonly"), scope("gmail.readonly"), scope("calendar.events.readonly"), "openid"][i],
    ])) {
      const issued = await grant(scopes);
      expect((await request(path, issued.access_token)).status).toBe(200);
      const deniedPath = path.startsWith("/drive") ? resourcePaths[1] : resourcePaths[0];
      const denied = await request(deniedPath, issued.access_token);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] },
      });
    }
  });

  it("rejects an identity-only token on every data route before changing state", async () => {
    const { app, store, grant, request } = fixture(true);
    const issued = await grant("openid email profile");
    const before = JSON.stringify(store.snapshot());
    const routes = app.routeTable.filter((route) => /^\/(upload\/)?(gmail|drive|calendar)\//.test(route.path));
    expect(routes.length).toBeGreaterThan(45);
    for (const route of routes) {
      const path = route.path.replace(/:[a-zA-Z]+/g, "me");
      expect(
        (await request(path, issued.access_token, route.method, route.method === "GET" ? undefined : {})).status,
        `${route.method} ${path}`,
      ).toBe(403);
    }
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("expires access tokens at one hour and refreshes with the original scopes", async () => {
    const { grant, request, refresh } = fixture(true);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const issued = await grant(scope("drive.readonly"));
    clock.mockReturnValue(now + 3600 * 1000 - 1);
    expect((await request(resourcePaths[0], issued.access_token)).status).toBe(200);
    clock.mockReturnValue(now + 3600 * 1000);
    for (const path of resourcePaths) expect((await request(path, issued.access_token)).status).toBe(401);
    const renewed = await refresh(issued.refresh_token);
    expect(renewed.status).toBe(200);
    const body = (await renewed.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe(scope("drive.readonly"));
    expect((await request(resourcePaths[0], body.access_token)).status).toBe(200);
    expect((await request(resourcePaths[1], body.access_token)).status).toBe(403);
    expect((await request("/drive/v3/files", body.access_token, "POST", { name: "Denied" })).status).toBe(403);
  });

  it.each(["access_token", "refresh_token"] as const)(
    "revokes a grant through its %s without affecting other grants",
    async (credential) => {
      const { grant, refresh, revoke, request } = fixture(true);
      const issued = await grant(scope("drive"));
      const independent = await grant(scope("drive"));
      const renewed = (await (await refresh(issued.refresh_token)).json()) as { access_token: string };
      expect((await revoke(issued[credential])).status).toBe(200);
      for (const token of [issued.access_token, renewed.access_token]) {
        for (const path of resourcePaths) expect((await request(path, token)).status).toBe(401);
      }
      expect((await refresh(issued.refresh_token)).status).toBe(400);
      expect((await request(resourcePaths[0], independent.access_token)).status).toBe(200);
      expect((await revoke(issued[credential])).status).toBe(200);
    },
  );

  it("restores token validity from snapshots and rejects old tokens after reset", async () => {
    const { store, grant, request, revoke } = fixture(true);
    const issued = await grant(scope("drive.readonly"));
    const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
    await revoke(issued.access_token);
    expect((await request(resourcePaths[0], issued.access_token)).status).toBe(401);
    store.restore(snapshot);
    expect((await request(resourcePaths[0], issued.access_token)).status).toBe(200);
    store.reset();
    googlePlugin.seed?.(store, base);
    seedFromConfig(store, base, { strict_scopes: true });
    expect((await request(resourcePaths[0], issued.access_token)).status).toBe(401);
  });

  it("validates issued tokens without a shared token map", async () => {
    const { grant, request } = fixture(true, false);
    const issued = await grant(scope("drive.readonly"));
    const response = await request(resourcePaths[0], issued.access_token);
    expect(await response.json()).toMatchObject({ files: [{ id: "file", name: "Notes" }] });
  });

  it("keeps discovery, keys, and the sign-in page public", async () => {
    const { request } = fixture(true);
    for (const path of [
      "/.well-known/openid-configuration",
      "/oauth2/v3/certs",
      "/discovery/v1/apis/calendar/v3/rest",
      "/o/oauth2/v2/auth?client_id=google-client",
    ]) {
      expect((await request(path)).status).toBe(200);
    }
  });

  it("checks HEAD requests and requires the Bearer authentication scheme", async () => {
    const { app, grant, request } = fixture(true);
    const issued = await grant(scope("drive.readonly"));
    expect((await request(resourcePaths[0], undefined, "HEAD")).status).toBe(401);
    expect((await request(resourcePaths[0], issued.access_token, "HEAD")).status).toBe(200);
    const invalid = await app.request(`${base}${resourcePaths[0]}`, {
      headers: { Authorization: `Basic ${issued.access_token}` },
    });
    expect(invalid.status).toBe(401);
  });

  it("returns only the userinfo claims authorized by the requested scopes", async () => {
    const { grant, request } = fixture(true);
    for (const [scopes, claims] of [
      ["openid", ["sub"]],
      ["email", ["sub", "email", "email_verified", "hd"]],
      [scope("userinfo.profile"), ["sub", "name", "given_name", "family_name", "picture", "locale"]],
      ["", ["sub", "email", "email_verified", "hd", "name", "given_name", "family_name", "picture", "locale"]],
    ] as const) {
      const issued = await grant(scopes);
      const response = await request(resourcePaths[3], issued.access_token);
      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()) as Record<string, unknown>).sort()).toEqual([...claims].sort());
    }
  });
});

describe("Google method scope requirements", () => {
  it("separates Drive metadata, download, and write permissions, including uploads", async () => {
    const { grant, request } = fixture(true);
    const metadata = await grant(scope("drive.metadata.readonly"));
    expect((await request("/drive/v3/files/file", metadata.access_token)).status).toBe(200);
    expect((await request("/drive/v3/files/file?alt=media", metadata.access_token)).status).toBe(403);
    const readonly = await grant(scope("drive.readonly"));
    expect(await (await request("/drive/v3/files/file?alt=media", readonly.access_token)).text()).toBe("notes");
    for (const [path, method] of [
      ["/drive/v3/files", "POST"],
      ["/upload/drive/v3/files", "POST"],
      ["/drive/v3/files/file?alt=media", "PATCH"],
      ["/drive/v3/files/file", "PUT"],
    ]) {
      expect((await request(path, readonly.access_token, method, { name: "Denied" })).status).toBe(403);
    }
    const writer = await grant(scope("drive"));
    expect((await request("/upload/drive/v3/files", writer.access_token, "POST", { name: "Created" })).status).toBe(
      200,
    );
    expect((await request("/drive/v3/files/file", writer.access_token, "PATCH", { name: "Renamed" })).status).toBe(200);
  });

  it("permits sending without reading and protects permanent deletion", async () => {
    const { grant, request } = fixture(true);
    const sender = await grant(scope("gmail.send"));
    expect((await request(resourcePaths[1], sender.access_token)).status).toBe(403);
    for (const prefix of ["", "/upload"]) {
      expect(
        (
          await request(`${prefix}/gmail/v1/users/me/messages/send`, sender.access_token, "POST", {
            to: "bob@example.com",
            body_text: "Hello",
          })
        ).status,
      ).toBe(200);
    }
    const modifier = await grant(scope("gmail.modify"));
    expect((await request("/gmail/v1/users/me/messages/message/trash", modifier.access_token, "POST", {})).status).toBe(
      200,
    );
    expect((await request("/gmail/v1/users/me/messages/message", modifier.access_token, "DELETE")).status).toBe(403);
    const full = await grant("https://mail.google.com/");
    expect((await request("/gmail/v1/users/me/messages/message", full.access_token, "DELETE")).status).toBe(204);
  });

  it("restricts Gmail metadata tokens to metadata and forbids body searches", async () => {
    const { grant, request } = fixture(true);
    const issued = await grant(scope("gmail.metadata"));
    expect((await request(resourcePaths[1], issued.access_token)).status).toBe(200);
    expect((await request(`${resourcePaths[1]}?q=Hello`, issued.access_token)).status).toBe(403);
    expect((await request("/gmail/v1/users/me/messages/message?format=metadata", issued.access_token)).status).toBe(
      200,
    );
    expect((await request("/gmail/v1/users/me/messages/message?format=raw", issued.access_token)).status).toBe(403);
    expect((await request("/gmail/v1/users/me/messages/message", issued.access_token)).status).toBe(403);
    expect(
      (await request("/gmail/v1/users/me/messages/message/attachments/attachment", issued.access_token)).status,
    ).toBe(403);
  });

  it("separates label and settings permissions from mailbox writes", async () => {
    const { grant, request } = fixture(true);
    const labels = await grant(scope("gmail.labels"));
    expect((await request("/gmail/v1/users/me/labels", labels.access_token, "POST", { name: "Allowed" })).status).toBe(
      200,
    );
    expect((await request(resourcePaths[1], labels.access_token)).status).toBe(403);
    const mailbox = await grant("https://mail.google.com/");
    expect(
      (
        await request("/gmail/v1/users/me/settings/filters", mailbox.access_token, "POST", {
          action: { addLabelIds: ["INBOX"] },
        })
      ).status,
    ).toBe(403);
    const settings = await grant(scope("gmail.settings.basic"));
    expect(
      (
        await request("/gmail/v1/users/me/settings/filters", settings.access_token, "POST", {
          action: { addLabelIds: ["INBOX"] },
        })
      ).status,
    ).toBe(200);
    expect((await request("/gmail/v1/users/me/settings/sendAs", settings.access_token)).status).toBe(200);
  });

  it("separates calendar lists, event reads, event writes, and free/busy queries", async () => {
    const { grant, request } = fixture(true);
    const readonly = await grant(scope("calendar.readonly"));
    const body = {
      summary: "Meeting",
      start: { dateTime: "2026-01-01T10:00:00Z" },
      end: { dateTime: "2026-01-01T11:00:00Z" },
    };
    expect((await request("/calendar/v3/users/me/calendarList", readonly.access_token)).status).toBe(200);
    expect((await request(resourcePaths[2], readonly.access_token, "POST", body)).status).toBe(403);
    const events = await grant(scope("calendar.events"));
    expect((await request("/calendar/v3/users/me/calendarList", events.access_token)).status).toBe(403);
    expect((await request(resourcePaths[2], events.access_token, "POST", body)).status).toBe(200);
    const freebusy = await grant(scope("calendar.freebusy"));
    expect((await request(resourcePaths[2], freebusy.access_token)).status).toBe(403);
    expect(
      (
        await request("/calendar/v3/freeBusy", freebusy.access_token, "POST", {
          timeMin: body.start.dateTime,
          timeMax: body.end.dateTime,
          items: [{ id: "primary" }],
        })
      ).status,
    ).toBe(200);
    const eventAvailability = await grant(scope("calendar.events.freebusy"));
    expect((await request(resourcePaths[2], eventAvailability.access_token)).status).toBe(403);
  });
});

describe.each([undefined, false])("Google permissive OAuth compatibility (strict_scopes=%s)", (strict) => {
  it("retains response bodies for arbitrary, expired, revoked, refresh, and narrowly scoped credentials", async () => {
    const { grant, request, revoke, refresh } = fixture(strict);
    const issued = await grant("openid");
    const unrevoked = await grant("openid");
    const original = await Promise.all(
      resourcePaths.map(async (path) => (await request(path, issued.access_token)).json()),
    );
    await revoke(issued.access_token);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600 * 1000);
    for (const token of ["unknown", issued.access_token, unrevoked.access_token, issued.refresh_token]) {
      for (const [i, path] of resourcePaths.entries()) {
        const response = await request(path, token);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(original[i]);
      }
    }
    clock.mockRestore();
    expect((await refresh(issued.refresh_token)).status).toBe(200);
    for (const path of resourcePaths) expect((await request(path)).status).toBe(401);
  });
});
