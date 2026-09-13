import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "@emulators/core";
import { decodeJwt } from "jose";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";
import { buildRawMessage } from "../helpers.js";

const base = "http://localhost:4000";

function createTestApp(options?: { strictScopes?: boolean; useFallback?: boolean }) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", {
    login: "testuser@example.com",
    id: 1,
    scopes: ["openid", "email", "profile"],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(
      tokenMap,
      undefined,
      options?.useFallback
        ? { login: "testuser@example.com", id: 1, scopes: ["openid", "email", "profile"] }
        : undefined,
    ),
  );
  googlePlugin.register(app as any, store, webhooks, base, tokenMap);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    ...(options?.strictScopes === undefined ? {} : { strict_scopes: options.strictScopes }),
    users: [
      { email: "testuser@example.com", name: "Test User" },
      { email: "consumer@gmail.com", name: "Consumer User" },
      { email: "workspaceuser@example.com", name: "Workspace User", hd: "override.io" },
    ],
    oauth_clients: [
      {
        client_id: "emu_google_client_id",
        client_secret: "emu_google_client_secret",
        name: "Inbox Zero",
        redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
      },
    ],
    labels: [
      {
        id: "Label_ops",
        user_email: "testuser@example.com",
        name: "Ops/Review",
        color_background: "#DDEEFF",
        color_text: "#111111",
      },
    ],
    messages: [
      {
        id: "msg_support_1",
        thread_id: "thread_support",
        user_email: "testuser@example.com",
        from: "Support <support@example.com>",
        to: "testuser@example.com",
        subject: "Your support ticket has been updated",
        body_text: "We have an update on your ticket.",
        label_ids: ["INBOX", "UNREAD", "Label_ops"],
        date: "2025-01-04T10:00:00.000Z",
      },
      {
        id: "msg_support_2",
        thread_id: "thread_support",
        user_email: "testuser@example.com",
        from: "testuser@example.com",
        to: "Support <support@example.com>",
        subject: "Re: Your support ticket has been updated",
        body_text: "Thanks for the update.",
        label_ids: ["SENT"],
        date: "2025-01-04T11:00:00.000Z",
        references: "<msg_support_1@emulate.google.local>",
        in_reply_to: "<msg_support_1@emulate.google.local>",
      },
      {
        id: "msg_invoice",
        thread_id: "thread_billing",
        user_email: "testuser@example.com",
        from: "Billing <billing@example.com>",
        to: "testuser@example.com",
        subject: "Invoice ready for review",
        body_text: "Your January invoice is ready to review.",
        label_ids: ["INBOX", "CATEGORY_UPDATES"],
        date: "2025-01-03T10:00:00.000Z",
      },
      {
        id: "msg_release",
        thread_id: "thread_release",
        user_email: "testuser@example.com",
        from: "Releases <release@example.com>",
        to: "testuser@example.com",
        subject: "Release notes available",
        body_html: "<p>The latest release is ready.</p>",
        label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
        date: "2025-01-02T10:00:00.000Z",
      },
      {
        id: "msg_draft",
        thread_id: "thread_draft",
        user_email: "testuser@example.com",
        from: "testuser@example.com",
        to: "partner@example.com",
        subject: "Draft follow-up",
        body_text: "This draft should only appear when not filtered.",
        label_ids: ["DRAFT"],
        date: "2025-01-01T10:00:00.000Z",
      },
    ],
    calendars: [
      {
        id: "primary",
        user_email: "testuser@example.com",
        summary: "testuser@example.com",
        primary: true,
        selected: true,
        time_zone: "UTC",
      },
      {
        id: "cal_team",
        user_email: "testuser@example.com",
        summary: "Team Calendar",
        description: "Shared engineering schedule",
        selected: true,
        time_zone: "UTC",
      },
    ],
    calendar_events: [
      {
        id: "evt_kickoff",
        user_email: "testuser@example.com",
        calendar_id: "primary",
        summary: "Project Kickoff",
        description: "Align on the Q1 plan.",
        start_date_time: "2025-01-10T09:00:00.000Z",
        end_date_time: "2025-01-10T09:30:00.000Z",
        attendees: [
          { email: "testuser@example.com", display_name: "Test User" },
          { email: "teammate@example.com", display_name: "Teammate" },
        ],
        conference_entry_points: [
          {
            entry_point_type: "video",
            uri: "https://meet.google.com/project-kickoff",
            label: "Google Meet",
          },
        ],
        hangout_link: "https://meet.google.com/project-kickoff",
      },
    ],
    drive_items: [
      {
        id: "drv_docs",
        user_email: "testuser@example.com",
        name: "Docs",
        mime_type: "application/vnd.google-apps.folder",
        parent_ids: ["root"],
      },
      {
        id: "drv_handbook",
        user_email: "testuser@example.com",
        name: "Handbook.pdf",
        mime_type: "application/pdf",
        parent_ids: ["drv_docs"],
        data: "pdf-handbook-data",
      },
    ],
  });

  return { app, store };
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: "Bearer test-token", ...extra };
}

async function jsonRequest(
  app: Hono,
  path: string,
  init?: Omit<RequestInit, "body" | "headers"> & { body?: unknown; headers?: Record<string, string> },
) {
  const headers = authHeaders({ "Content-Type": "application/json", ...(init?.headers ?? {}) });
  const body =
    init?.body === undefined || typeof init.body === "string"
      ? (init?.body as string | undefined)
      : JSON.stringify(init.body);

  return app.request(`${base}${path}`, {
    ...init,
    headers,
    body,
  });
}

async function formRequest(app: Hono, path: string, body: Record<string, string>, init?: RequestInit) {
  return app.request(`${base}${path}`, {
    ...init,
    method: init?.method ?? "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init?.headers ?? {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

async function issueGoogleToken(app: Hono, scope?: string) {
  const authorizationBody: Record<string, string> = {
    email: "testuser@example.com",
    redirect_uri: "http://localhost:3000/api/auth/callback/google",
    client_id: "emu_google_client_id",
  };
  if (scope !== undefined) authorizationBody.scope = scope;

  const authorizeRes = await formRequest(app, "/o/oauth2/v2/auth/callback", authorizationBody);
  const code = new URL(authorizeRes.headers.get("Location")!).searchParams.get("code")!;
  const tokenRes = await formRequest(app, "/oauth2/token", {
    code,
    grant_type: "authorization_code",
    redirect_uri: "http://localhost:3000/api/auth/callback/google",
    client_id: "emu_google_client_id",
    client_secret: "emu_google_client_secret",
  });
  expect(tokenRes.status).toBe(200);
  return (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
}

describe("Google plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  describe("strict OAuth authority", () => {
    const routes = ["/drive/v3/files", "/gmail/v1/users/me/messages", "/calendar/v3/calendars/primary/events"];

    it("rejects bearer tokens that Google did not issue", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;

      for (const route of routes) {
        const res = await strictApp.request(`${base}${route}`, {
          headers: { Authorization: "Bearer totally-bogus-token" },
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({
          error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] },
        });
      }
    });

    it("accepts authorization-code tokens with matching service scopes", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const cases = [
        ["/drive/v3/files", "https://www.googleapis.com/auth/drive"],
        ["/gmail/v1/users/me/messages", "https://www.googleapis.com/auth/gmail.readonly"],
        ["/calendar/v3/calendars/primary/events", "https://www.googleapis.com/auth/calendar.readonly"],
      ] as const;

      for (const [route, scope] of cases) {
        const token = await issueGoogleToken(strictApp, scope);
        const res = await strictApp.request(`${base}${route}`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(res.status).toBe(200);
      }
    });

    it("enforces operation-specific Gmail scopes", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const insertScopes = [
        "https://www.googleapis.com/auth/gmail.insert",
        "https://www.googleapis.com/auth/gmail.modify",
      ];

      for (const scope of insertScopes) {
        const token = await issueGoogleToken(strictApp, scope);
        const importRes = await jsonRequest(strictApp, "/gmail/v1/users/me/messages/import", {
          method: "POST",
          headers: { Authorization: `Bearer ${token.access_token}` },
          body: { from: "sender@example.com", to: "testuser@example.com" },
        });
        expect(importRes.status).toBe(200);

        const insertRes = await jsonRequest(strictApp, "/gmail/v1/users/me/messages", {
          method: "POST",
          headers: { Authorization: `Bearer ${token.access_token}` },
          body: { from: "sender@example.com", to: "testuser@example.com" },
        });
        expect(insertRes.status).toBe(200);
      }

      for (const path of [
        "/gmail/v1/users/me/messages/batchDelete",
        "/gmail/v1/users/me/messages/msg_invoice",
        "/gmail/v1/users/me/threads/thread_billing",
      ]) {
        const token = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/gmail.modify");
        const res = await jsonRequest(strictApp, path, {
          method: path.endsWith("batchDelete") ? "POST" : "DELETE",
          headers: { Authorization: `Bearer ${token.access_token}` },
          body: path.endsWith("batchDelete") ? { ids: ["msg_invoice"] } : undefined,
        });
        expect(res.status).toBe(403);
      }

      const insertOnlyToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/gmail.insert");
      const batchDeleteRes = await jsonRequest(strictApp, "/gmail/v1/users/me/messages/batchDelete", {
        method: "POST",
        headers: { Authorization: `Bearer ${insertOnlyToken.access_token}` },
        body: { ids: ["msg_invoice"] },
      });
      expect(batchDeleteRes.status).toBe(403);
    });

    it("separates message send and draft send scopes", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const sendToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/gmail.send");

      const messageSendRes = await jsonRequest(strictApp, "/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${sendToken.access_token}` },
        body: { from: "testuser@example.com", to: "partner@example.com", subject: "Sent message" },
      });
      expect(messageSendRes.status).toBe(200);

      for (const path of ["/gmail/v1/users/me/drafts/send", "/upload/gmail/v1/users/me/drafts/send"]) {
        const draftSendRes = await jsonRequest(strictApp, path, {
          method: "POST",
          headers: { Authorization: `Bearer ${sendToken.access_token}` },
          body: { id: "msg_draft" },
        });
        expect(draftSendRes.status).toBe(403);
      }

      const draftToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/gmail.compose");
      const createDraftRes = await jsonRequest(strictApp, "/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: { Authorization: `Bearer ${draftToken.access_token}` },
        body: {
          message: {
            from: "testuser@example.com",
            to: "partner@example.com",
            subject: "Draft message",
          },
        },
      });
      expect(createDraftRes.status).toBe(200);
      const draft = (await createDraftRes.json()) as { id: string };
      const draftSendRes = await jsonRequest(strictApp, "/gmail/v1/users/me/drafts/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${draftToken.access_token}` },
        body: { id: draft.id },
      });
      expect(draftSendRes.status).toBe(200);
    });

    it("separates Drive metadata and media access", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;

      for (const scope of [
        "https://www.googleapis.com/auth/drive.metadata",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
      ]) {
        const token = await issueGoogleToken(strictApp, scope);
        const metadataRes = await strictApp.request(`${base}/drive/v3/files/drv_handbook`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(metadataRes.status).toBe(200);

        const mediaRes = await strictApp.request(`${base}/drive/v3/files/drv_handbook?alt=media`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(mediaRes.status).toBe(403);
      }

      const contentToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/drive.readonly");
      const mediaRes = await strictApp.request(`${base}/drive/v3/files/drv_handbook?alt=media`, {
        headers: { Authorization: `Bearer ${contentToken.access_token}` },
      });
      expect(mediaRes.status).toBe(200);

      const metadataToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/drive.metadata");
      const putRes = await jsonRequest(strictApp, "/drive/v3/files/drv_handbook", {
        method: "PUT",
        headers: { Authorization: `Bearer ${metadataToken.access_token}` },
        body: {},
      });
      expect(putRes.status).toBe(403);

      const patchRes = await jsonRequest(strictApp, "/drive/v3/files/drv_handbook", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${metadataToken.access_token}` },
        body: {},
      });
      expect(patchRes.status).toBe(200);
    });

    it("rejects malformed persisted access token records", async () => {
      const { app: strictApp, store } = createTestApp({ strictScopes: true, useFallback: true });
      const records: Array<Record<string, unknown>> = [
        {
          email: "testuser@example.com",
          userId: 1,
          scopes: ["https://www.googleapis.com/auth/drive"],
          clientId: "emu_google_client_id",
          expiresAt: Date.now() + 60_000,
        },
        {
          email: "testuser@example.com",
          userId: 1,
          scopes: { drive: true },
          clientId: "emu_google_client_id",
          expiresAt: Date.now() + 60_000,
          revoked: false,
        },
        {
          email: "testuser@example.com",
          userId: Number.POSITIVE_INFINITY,
          scopes: ["https://www.googleapis.com/auth/drive"],
          clientId: "emu_google_client_id",
          expiresAt: Date.now() + 60_000,
          revoked: false,
        },
        {
          email: "testuser@example.com",
          userId: 1,
          scopes: ["https://www.googleapis.com/auth/drive"],
          clientId: "emu_google_client_id",
          expiresAt: Number.POSITIVE_INFINITY,
          revoked: false,
        },
        {
          email: 123,
          userId: 1,
          scopes: ["https://www.googleapis.com/auth/drive"],
          clientId: "emu_google_client_id",
          expiresAt: Date.now() + 60_000,
          revoked: false,
        },
        {
          email: "testuser@example.com",
          userId: 1,
          scopes: ["https://www.googleapis.com/auth/drive"],
          clientId: null,
          expiresAt: Date.now() + 60_000,
          revoked: false,
        },
      ];

      for (const record of records) {
        store.setData("google.oauth.accessTokens", new Map([["malformed-token", record]]));
        const res = await strictApp.request(`${base}/drive/v3/files`, {
          headers: { Authorization: "Bearer malformed-token" },
        });
        expect(res.status).toBe(401);
      }
    });

    it("accepts documented Calendar freebusy and Gmail settings read scopes", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const freeBusyToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/calendar.freebusy");
      const freeBusyRes = await jsonRequest(strictApp, "/calendar/v3/freeBusy", {
        method: "POST",
        headers: { Authorization: `Bearer ${freeBusyToken.access_token}` },
        body: {
          timeMin: "2025-01-10T11:00:00.000Z",
          timeMax: "2025-01-10T14:00:00.000Z",
          items: [{ id: "primary" }],
        },
      });
      expect(freeBusyRes.status).toBe(200);

      for (const scope of [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ]) {
        const token = await issueGoogleToken(strictApp, scope);
        const settingsRes = await strictApp.request(`${base}/gmail/v1/users/me/settings/sendAs`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(settingsRes.status).toBe(200);
      }

      const sharingToken = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/gmail.settings.sharing");
      const sharingRes = await strictApp.request(`${base}/gmail/v1/users/me/settings/sendAs`, {
        headers: { Authorization: `Bearer ${sharingToken.access_token}` },
      });
      expect(sharingRes.status).toBe(403);
    });

    it("stores default OAuth scopes when authorization omits scope", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const token = await issueGoogleToken(strictApp);
      expect(token.scope).toBe("openid email profile");

      const userinfoRes = await strictApp.request(`${base}/oauth2/v2/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      expect(userinfoRes.status).toBe(200);

      const refreshRes = await formRequest(strictApp, "/oauth2/token", {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: "emu_google_client_id",
        client_secret: "emu_google_client_secret",
      });
      expect(refreshRes.status).toBe(200);
      const refreshed = (await refreshRes.json()) as { access_token: string; scope: string };
      expect(refreshed.scope).toBe("openid email profile");

      const refreshedUserinfoRes = await strictApp.request(`${base}/oauth2/v2/userinfo`, {
        headers: { Authorization: `Bearer ${refreshed.access_token}` },
      });
      expect(refreshedUserinfoRes.status).toBe(200);
    });

    it("rejects revoked access tokens", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const token = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/drive");

      const before = await strictApp.request(`${base}/drive/v3/files`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      expect(before.status).toBe(200);

      const revoke = await formRequest(strictApp, "/oauth2/revoke", { token: token.access_token });
      expect(revoke.status).toBe(200);

      const after = await strictApp.request(`${base}/drive/v3/files`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      expect(after.status).toBe(401);
      expect(await after.json()).toMatchObject({ error: { status: "UNAUTHENTICATED" } });
    });

    it("rejects access tokens without a scope for the requested service", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const token = await issueGoogleToken(strictApp, "openid");

      for (const route of routes) {
        const res = await strictApp.request(`${base}${route}`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientPermissions" }],
          },
        });
      }
    });

    it("rejects refresh tokens presented to resource APIs", async () => {
      const strictApp = createTestApp({ strictScopes: true, useFallback: true }).app;
      const token = await issueGoogleToken(strictApp, "https://www.googleapis.com/auth/drive");
      const res = await strictApp.request(`${base}/drive/v3/files`, {
        headers: { Authorization: `Bearer ${token.refresh_token}` },
      });
      expect(res.status).toBe(401);
    });

    it.each([undefined, false])("preserves permissive auth when strict_scopes is %s", async (strictScopes) => {
      const permissiveApp = createTestApp({ strictScopes, useFallback: true }).app;

      for (const route of routes) {
        const expected = await permissiveApp.request(`${base}${route}`, { headers: authHeaders() });
        const bogus = await permissiveApp.request(`${base}${route}`, {
          headers: { Authorization: "Bearer totally-bogus-token" },
        });
        expect(bogus.status).toBe(200);
        expect(await bogus.text()).toBe(await expected.text());
      }

      const token = await issueGoogleToken(permissiveApp, "openid");
      const revoke = await formRequest(permissiveApp, "/oauth2/revoke", { token: token.access_token });
      expect(revoke.status).toBe(200);

      for (const credential of [token.access_token, token.refresh_token]) {
        const expected = await permissiveApp.request(`${base}/drive/v3/files`, { headers: authHeaders() });
        const res = await permissiveApp.request(`${base}/drive/v3/files`, {
          headers: { Authorization: `Bearer ${credential}` },
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(await expected.text());
      }
    });
  });

  it("returns user info for a valid token", async () => {
    const res = await app.request(`${base}/oauth2/v2/userinfo`, { headers: authHeaders() });
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

  it("lists paginated messages with Gmail-style filters", async () => {
    const res = await app.request(
      `${base}/gmail/v1/users/me/messages?maxResults=2&q=${encodeURIComponent("-label:DRAFT in:inbox")}`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate: number;
    };

    expect(body.messages).toEqual([
      { id: "msg_support_1", threadId: "thread_support" },
      { id: "msg_invoice", threadId: "thread_billing" },
    ]);
    expect(body.nextPageToken).toBe("2");
    expect(body.resultSizeEstimate).toBe(3);
  });

  it("returns message payloads in metadata and raw formats", async () => {
    const metadataRes = await app.request(
      `${base}/gmail/v1/users/me/messages/msg_release?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: authHeaders() },
    );

    expect(metadataRes.status).toBe(200);
    const metadataBody = (await metadataRes.json()) as {
      payload: { headers: Array<{ name: string; value: string }>; body: { size: number } };
    };

    expect(metadataBody.payload.headers).toEqual([
      { name: "From", value: "Releases <release@example.com>" },
      { name: "Subject", value: "Release notes available" },
    ]);
    expect(metadataBody.payload.body.size).toBe(0);

    const rawRes = await app.request(`${base}/gmail/v1/users/me/messages/msg_release?format=raw`, {
      headers: authHeaders(),
    });
    const rawBody = (await rawRes.json()) as { raw?: string };
    expect(rawBody.raw).toBeDefined();
  });

  it("returns attachment parts and serves attachment bodies", async () => {
    const raw = buildRawMessage({
      from: "Contracts <contracts@example.com>",
      to: "testuser@example.com",
      subject: "Signed contract attached",
      body_text: "Please review the attached contract.",
      body_html: "<p>Please review the attached contract.</p>",
      attachments: [
        {
          filename: "contract.pdf",
          mime_type: "application/pdf",
          content: "fake-pdf-data",
        },
      ],
    });

    const importRes = await jsonRequest(app, "/gmail/v1/users/me/messages/import", {
      method: "POST",
      body: {
        raw,
        labelIds: ["INBOX"],
      },
    });

    expect(importRes.status).toBe(200);
    const imported = (await importRes.json()) as { id: string };

    const messageRes = await app.request(`${base}/gmail/v1/users/me/messages/${imported.id}`, {
      headers: authHeaders(),
    });
    expect(messageRes.status).toBe(200);

    const message = (await messageRes.json()) as {
      payload: {
        mimeType: string;
        parts?: Array<{
          filename?: string;
          body?: { attachmentId?: string; size?: number };
        }>;
      };
    };

    expect(message.payload.mimeType).toBe("multipart/mixed");
    const attachmentPart = message.payload.parts?.find((part) => part.filename === "contract.pdf");
    expect(attachmentPart?.body?.attachmentId).toBeDefined();
    expect(attachmentPart?.body?.size).toBe(Buffer.byteLength("fake-pdf-data", "utf8"));

    const attachmentRes = await app.request(
      `${base}/gmail/v1/users/me/messages/${imported.id}/attachments/${attachmentPart!.body!.attachmentId}`,
      { headers: authHeaders() },
    );
    expect(attachmentRes.status).toBe(200);

    const attachment = (await attachmentRes.json()) as { data: string; size: number };
    expect(Buffer.from(attachment.data, "base64url").toString("utf8")).toBe("fake-pdf-data");
    expect(attachment.size).toBe(Buffer.byteLength("fake-pdf-data", "utf8"));

    const listRes = await app.request(`${base}/gmail/v1/users/me/messages?q=${encodeURIComponent("has:attachment")}`, {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      messages: Array<{ id: string }>;
    };
    expect(listBody.messages.some((entry) => entry.id === imported.id)).toBe(true);
  });

  it("creates, updates, lists, sends, and deletes drafts", async () => {
    const createRaw = buildRawMessage({
      from: "testuser@example.com",
      to: "partner@example.com",
      subject: "Draft review",
      body_html: "<p>First draft body</p>",
    });

    const createRes = await jsonRequest(app, "/gmail/v1/users/me/drafts", {
      method: "POST",
      body: {
        message: {
          threadId: "thread_support",
          raw: createRaw,
        },
      },
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      id: string;
      message: {
        id: string;
        threadId: string;
        labelIds: string[];
        payload: { headers: Array<{ name: string; value: string }> };
      };
    };

    expect(created.id).toMatch(/^r-\d+$/);
    expect(created.message.threadId).toBe("thread_support");
    expect(created.message.labelIds).toContain("DRAFT");
    expect(created.message.payload.headers.find((header) => header.name === "Subject")?.value).toBe("Draft review");

    const listRes = await app.request(`${base}/gmail/v1/users/me/drafts?maxResults=20`, {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      drafts: Array<{ id: string; message?: { id: string; threadId: string } }>;
    };
    expect(listBody.drafts.some((draft) => draft.id === created.id && draft.message?.id === created.message.id)).toBe(
      true,
    );

    const getRes = await app.request(`${base}/gmail/v1/users/me/drafts/${created.id}?format=full`, {
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);

    const updateRaw = buildRawMessage({
      from: "testuser@example.com",
      to: "partner@example.com",
      subject: "Draft review updated",
      body_html: "<p>Updated draft body</p>",
    });

    const updateRes = await jsonRequest(app, `/gmail/v1/users/me/drafts/${created.id}`, {
      method: "PUT",
      body: {
        message: {
          raw: updateRaw,
        },
      },
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      id: string;
      message: { id: string; labelIds: string[]; payload: { headers: Array<{ name: string; value: string }> } };
    };
    expect(updated.id).toBe(created.id);
    expect(updated.message.id).toBe(created.message.id);
    expect(updated.message.labelIds).toContain("DRAFT");
    expect(updated.message.payload.headers.find((header) => header.name === "Subject")?.value).toBe(
      "Draft review updated",
    );

    const sendRes = await jsonRequest(app, "/gmail/v1/users/me/drafts/send", {
      method: "POST",
      body: { id: created.id },
    });
    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as { id: string; threadId: string; labelIds: string[] };
    expect(sent.id).toBe(created.message.id);
    expect(sent.threadId).toBe("thread_support");
    expect(sent.labelIds).toContain("SENT");
    expect(sent.labelIds).not.toContain("DRAFT");

    const missingDraftRes = await app.request(`${base}/gmail/v1/users/me/drafts/${created.id}`, {
      headers: authHeaders(),
    });
    expect(missingDraftRes.status).toBe(404);

    const deleteRaw = buildRawMessage({
      from: "testuser@example.com",
      to: "delete@example.com",
      subject: "Delete me",
      body_text: "Disposable draft",
    });
    const secondCreateRes = await jsonRequest(app, "/gmail/v1/users/me/drafts", {
      method: "POST",
      body: {
        message: { raw: deleteRaw },
      },
    });
    const secondDraft = (await secondCreateRes.json()) as { id: string; message: { id: string } };

    const deleteRes = await app.request(`${base}/gmail/v1/users/me/drafts/${secondDraft.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const deletedMessageRes = await app.request(`${base}/gmail/v1/users/me/messages/${secondDraft.message.id}`, {
      headers: authHeaders(),
    });
    expect(deletedMessageRes.status).toBe(404);
  });

  it("tracks history entries after watch registration", async () => {
    const watchRes = await jsonRequest(app, "/gmail/v1/users/me/watch", {
      method: "POST",
      body: {
        topicName: "projects/emulate-local/topics/gmail",
        labelIds: ["INBOX", "SENT"],
        labelFilterBehavior: "include",
      },
    });
    expect(watchRes.status).toBe(200);

    const watch = (await watchRes.json()) as { historyId: string; expiration: string };
    expect(BigInt(watch.historyId)).toBeGreaterThan(0n);
    expect(BigInt(watch.expiration)).toBeGreaterThan(BigInt(Date.now()));

    const importRaw = buildRawMessage({
      from: "Alerts <alerts@example.com>",
      to: "testuser@example.com",
      subject: "Deployment notification",
      body_text: "A deployment has finished successfully.",
    });
    const importRes = await jsonRequest(app, "/gmail/v1/users/me/messages/import", {
      method: "POST",
      body: {
        raw: importRaw,
        labelIds: ["INBOX", "UNREAD"],
      },
    });
    expect(importRes.status).toBe(200);

    const imported = (await importRes.json()) as { id: string };

    const modifyRes = await jsonRequest(app, `/gmail/v1/users/me/messages/${imported.id}/modify`, {
      method: "POST",
      body: {
        addLabelIds: ["STARRED"],
        removeLabelIds: ["UNREAD"],
      },
    });
    expect(modifyRes.status).toBe(200);

    const historyRes = await app.request(
      `${base}/gmail/v1/users/me/history?startHistoryId=${watch.historyId}&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved`,
      { headers: authHeaders() },
    );
    expect(historyRes.status).toBe(200);

    const historyBody = (await historyRes.json()) as {
      historyId: string;
      history: Array<{
        id: string;
        messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
        labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
        labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
      }>;
    };

    expect(BigInt(historyBody.historyId)).toBeGreaterThan(BigInt(watch.historyId));
    expect(
      historyBody.history.some((entry) => entry.messagesAdded?.some((item) => item.message.id === imported.id)),
    ).toBe(true);
    expect(
      historyBody.history.some((entry) =>
        entry.labelsAdded?.some((item) => item.message.id === imported.id && item.labelIds.includes("STARRED")),
      ),
    ).toBe(true);
    expect(
      historyBody.history.some((entry) =>
        entry.labelsRemoved?.some((item) => item.message.id === imported.id && item.labelIds.includes("UNREAD")),
      ),
    ).toBe(true);

    const stopRes = await app.request(`${base}/gmail/v1/users/me/stop`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(stopRes.status).toBe(200);
  });

  it("lists settings resources and applies Gmail filters to matching messages", async () => {
    const sendAsRes = await app.request(`${base}/gmail/v1/users/me/settings/sendAs`, {
      headers: authHeaders(),
    });
    expect(sendAsRes.status).toBe(200);
    const sendAsBody = (await sendAsRes.json()) as {
      sendAs: Array<{ sendAsEmail: string; displayName?: string; isDefault: boolean }>;
    };
    expect(sendAsBody.sendAs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sendAsEmail: "testuser@example.com",
          displayName: "Test User",
          isDefault: true,
        }),
      ]),
    );

    const forwardingRes = await app.request(`${base}/gmail/v1/users/me/settings/forwardingAddresses`, {
      headers: authHeaders(),
    });
    expect(forwardingRes.status).toBe(200);
    const forwardingBody = (await forwardingRes.json()) as {
      forwardingAddresses: Array<{ forwardingEmail: string }>;
    };
    expect(forwardingBody.forwardingAddresses).toEqual([]);

    const createFilterRes = await jsonRequest(app, "/gmail/v1/users/me/settings/filters", {
      method: "POST",
      body: {
        criteria: { from: "billing@example.com" },
        action: { addLabelIds: ["Label_ops"], removeLabelIds: ["INBOX"] },
      },
    });
    expect(createFilterRes.status).toBe(200);
    const filter = (await createFilterRes.json()) as {
      id: string;
      criteria: { from: string };
      action: { addLabelIds: string[]; removeLabelIds: string[] };
    };
    expect(filter.criteria.from).toBe("billing@example.com");
    expect(filter.action.addLabelIds).toContain("Label_ops");
    expect(filter.action.removeLabelIds).toContain("INBOX");

    const duplicateFilterRes = await jsonRequest(app, "/gmail/v1/users/me/settings/filters", {
      method: "POST",
      body: {
        criteria: { from: "billing@example.com" },
        action: { addLabelIds: ["Label_ops"], removeLabelIds: ["INBOX"] },
      },
    });
    expect(duplicateFilterRes.status).toBe(400);
    const duplicateError = (await duplicateFilterRes.json()) as { error: { message: string } };
    expect(duplicateError.error.message).toBe("Filter already exists");

    const listFiltersRes = await app.request(`${base}/gmail/v1/users/me/settings/filters`, {
      headers: authHeaders(),
    });
    expect(listFiltersRes.status).toBe(200);
    const listedFilters = (await listFiltersRes.json()) as {
      filter: Array<{ id: string }>;
    };
    expect(listedFilters.filter).toEqual(expect.arrayContaining([expect.objectContaining({ id: filter.id })]));

    const filteredRaw = buildRawMessage({
      from: "Billing <billing@example.com>",
      to: "testuser@example.com",
      subject: "Filtered invoice",
      body_text: "This should be relabeled by the emulator filter.",
    });
    const filteredImportRes = await jsonRequest(app, "/gmail/v1/users/me/messages/import", {
      method: "POST",
      body: {
        raw: filteredRaw,
        labelIds: ["INBOX", "UNREAD"],
      },
    });
    expect(filteredImportRes.status).toBe(200);
    const filteredMessage = (await filteredImportRes.json()) as { id: string };

    const filteredMessageRes = await app.request(`${base}/gmail/v1/users/me/messages/${filteredMessage.id}`, {
      headers: authHeaders(),
    });
    expect(filteredMessageRes.status).toBe(200);
    const filteredBody = (await filteredMessageRes.json()) as { labelIds: string[] };
    expect(filteredBody.labelIds).toContain("Label_ops");
    expect(filteredBody.labelIds).toContain("UNREAD");
    expect(filteredBody.labelIds).not.toContain("INBOX");

    const deleteFilterRes = await app.request(`${base}/gmail/v1/users/me/settings/filters/${filter.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteFilterRes.status).toBe(204);

    const afterDeleteRes = await app.request(`${base}/gmail/v1/users/me/settings/filters`, {
      headers: authHeaders(),
    });
    expect(afterDeleteRes.status).toBe(200);
    const afterDelete = (await afterDeleteRes.json()) as {
      filter: Array<{ id: string }>;
    };
    expect(afterDelete.filter).toEqual([]);
  });

  it("creates sent messages and appends them to existing threads", async () => {
    const raw = buildRawMessage({
      from: "testuser@example.com",
      to: "Support <support@example.com>",
      subject: "Re: Your support ticket has been updated",
      body_text: "Closing the loop from the emulator.",
      message_id: "<outbound-1@example.com>",
      in_reply_to: "<msg_support_1@emulate.google.local>",
      references: "<msg_support_1@emulate.google.local>",
    });

    const sendRes = await jsonRequest(app, "/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: {
        threadId: "thread_support",
        raw,
      },
    });

    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as {
      id: string;
      threadId: string;
      labelIds: string[];
    };

    expect(sent.threadId).toBe("thread_support");
    expect(sent.labelIds).toContain("SENT");

    const threadRes = await app.request(`${base}/gmail/v1/users/me/threads/thread_support`, {
      headers: authHeaders(),
    });
    expect(threadRes.status).toBe(200);
    const thread = (await threadRes.json()) as {
      messages: Array<{ id: string }>;
    };
    expect(thread.messages).toHaveLength(3);
  });

  it("modifies, batches, trashes, and deletes messages", async () => {
    const labelRes = await jsonRequest(app, "/gmail/v1/users/me/labels", {
      method: "POST",
      body: { name: "Projects/Alpha" },
    });
    const label = (await labelRes.json()) as { id: string };

    const modifyRes = await jsonRequest(app, "/gmail/v1/users/me/messages/msg_invoice/modify", {
      method: "POST",
      body: { addLabelIds: [label.id], removeLabelIds: ["INBOX"] },
    });
    expect(modifyRes.status).toBe(200);
    const modified = (await modifyRes.json()) as { labelIds: string[] };
    expect(modified.labelIds).toContain(label.id);
    expect(modified.labelIds).not.toContain("INBOX");

    const batchModifyRes = await jsonRequest(app, "/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      body: { ids: ["msg_support_1", "msg_release"], addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
    });
    expect(batchModifyRes.status).toBe(204);

    const supportRes = await app.request(`${base}/gmail/v1/users/me/messages/msg_support_1`, {
      headers: authHeaders(),
    });
    const support = (await supportRes.json()) as { labelIds: string[] };
    expect(support.labelIds).toContain("STARRED");
    expect(support.labelIds).not.toContain("UNREAD");

    const trashRes = await jsonRequest(app, "/gmail/v1/users/me/messages/msg_release/trash", {
      method: "POST",
    });
    const trashed = (await trashRes.json()) as { labelIds: string[] };
    expect(trashed.labelIds).toContain("TRASH");
    expect(trashed.labelIds).not.toContain("INBOX");

    const untrashRes = await jsonRequest(app, "/gmail/v1/users/me/messages/msg_release/untrash", {
      method: "POST",
    });
    const untrashed = (await untrashRes.json()) as { labelIds: string[] };
    expect(untrashed.labelIds).toContain("INBOX");
    expect(untrashed.labelIds).not.toContain("TRASH");

    const batchDeleteRes = await jsonRequest(app, "/gmail/v1/users/me/messages/batchDelete", {
      method: "POST",
      body: { ids: ["msg_draft"] },
    });
    expect(batchDeleteRes.status).toBe(204);

    const deletedRes = await app.request(`${base}/gmail/v1/users/me/messages/msg_draft`, {
      headers: authHeaders(),
    });
    expect(deletedRes.status).toBe(404);
  });

  it("lists, gets, and mutates threads", async () => {
    const listRes = await app.request(
      `${base}/gmail/v1/users/me/threads?maxResults=10&q=${encodeURIComponent("-label:DRAFT")}`,
      { headers: authHeaders() },
    );
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as {
      threads: Array<{ id: string; snippet: string; historyId: string }>;
    };
    expect(listBody.threads.map((thread) => thread.id)).toEqual(["thread_support", "thread_billing", "thread_release"]);

    const modifyRes = await jsonRequest(app, "/gmail/v1/users/me/threads/thread_support/modify", {
      method: "POST",
      body: { addLabelIds: ["IMPORTANT"], removeLabelIds: ["UNREAD"] },
    });
    expect(modifyRes.status).toBe(200);

    const thread = (await modifyRes.json()) as {
      messages: Array<{ labelIds: string[] }>;
    };
    expect(thread.messages.every((message) => message.labelIds.includes("IMPORTANT"))).toBe(true);
    expect(thread.messages.some((message) => message.labelIds.includes("UNREAD"))).toBe(false);

    const trashRes = await jsonRequest(app, "/gmail/v1/users/me/threads/thread_support/trash", {
      method: "POST",
    });
    expect(trashRes.status).toBe(200);

    const hiddenListRes = await app.request(`${base}/gmail/v1/users/me/threads`, {
      headers: authHeaders(),
    });
    const hiddenList = (await hiddenListRes.json()) as { threads: Array<{ id: string }> };
    expect(hiddenList.threads.some((threadItem) => threadItem.id === "thread_support")).toBe(false);

    const untrashRes = await jsonRequest(app, "/gmail/v1/users/me/threads/thread_support/untrash", {
      method: "POST",
    });
    expect(untrashRes.status).toBe(200);

    const deleteRes = await app.request(`${base}/gmail/v1/users/me/threads/thread_billing`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(204);
  });

  it("creates, updates, and deletes user labels", async () => {
    const createRes = await jsonRequest(app, "/gmail/v1/users/me/labels", {
      method: "POST",
      body: {
        name: "Inbox Zero/Follow Up",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        color: {
          backgroundColor: "#ABCDEF",
          textColor: "#123456",
        },
      },
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; name: string; color?: { backgroundColor?: string } };
    expect(created.name).toBe("Inbox Zero/Follow Up");
    expect(created.color?.backgroundColor).toBe("#ABCDEF");

    await jsonRequest(app, "/gmail/v1/users/me/messages/msg_invoice/modify", {
      method: "POST",
      body: { addLabelIds: [created.id] },
    });

    const patchRes = await jsonRequest(app, `/gmail/v1/users/me/labels/${created.id}`, {
      method: "PATCH",
      body: {
        name: "Inbox Zero/Done",
        color: {
          backgroundColor: "#FEDCBA",
          textColor: "#654321",
        },
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { name: string; color?: { backgroundColor?: string } };
    expect(patched.name).toBe("Inbox Zero/Done");
    expect(patched.color?.backgroundColor).toBe("#FEDCBA");

    const getRes = await app.request(`${base}/gmail/v1/users/me/labels/${created.id}`, {
      headers: authHeaders(),
    });
    const fetched = (await getRes.json()) as { messagesTotal: number };
    expect(fetched.messagesTotal).toBe(1);

    const deleteRes = await app.request(`${base}/gmail/v1/users/me/labels/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(204);

    const messageRes = await app.request(`${base}/gmail/v1/users/me/messages/msg_invoice`, {
      headers: authHeaders(),
    });
    const message = (await messageRes.json()) as { labelIds: string[] };
    expect(message.labelIds).not.toContain(created.id);
  });

  it("exchanges auth codes for refresh tokens and refreshes access tokens", async () => {
    const authorizeRes = await formRequest(app, "/o/oauth2/v2/auth/callback", {
      email: "testuser@example.com",
      redirect_uri: "http://localhost:3000/api/auth/callback/google",
      scope: "openid email profile https://www.googleapis.com/auth/calendar.readonly",
      client_id: "emu_google_client_id",
    });

    expect(authorizeRes.status).toBe(302);
    const redirectLocation = authorizeRes.headers.get("Location");
    expect(redirectLocation).toBeTruthy();

    const redirectUrl = new URL(redirectLocation!);
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await formRequest(app, "/oauth2/token", {
      code: code!,
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:3000/api/auth/callback/google",
      client_id: "emu_google_client_id",
      client_secret: "emu_google_client_secret",
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokenBody.access_token).toMatch(/^google_/);
    expect(tokenBody.refresh_token).toMatch(/^google_refresh_/);

    const refreshRes = await formRequest(app, "/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: tokenBody.refresh_token,
      client_id: "emu_google_client_id",
      client_secret: "emu_google_client_secret",
    });

    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      access_token: string;
      scope: string;
    };
    expect(refreshBody.access_token).toMatch(/^google_/);
    expect(refreshBody.access_token).not.toBe(tokenBody.access_token);
    expect(refreshBody.scope).toBe(tokenBody.scope);
  });

  it("derives, overrides, and omits the hd claim based on user config", async () => {
    async function getIdTokenClaims(email: string) {
      const authorize = await formRequest(app, "/o/oauth2/v2/auth/callback", {
        email,
        redirect_uri: "http://localhost:3000/api/auth/callback/google",
        scope: "openid email profile",
        client_id: "emu_google_client_id",
      });
      const code = new URL(authorize.headers.get("Location")!).searchParams.get("code")!;
      const tokenRes = await formRequest(app, "/oauth2/token", {
        code,
        grant_type: "authorization_code",
        redirect_uri: "http://localhost:3000/api/auth/callback/google",
        client_id: "emu_google_client_id",
        client_secret: "emu_google_client_secret",
      });
      const body = (await tokenRes.json()) as { id_token: string; access_token: string };
      return { claims: decodeJwt(body.id_token) as { hd?: string }, accessToken: body.access_token };
    }

    const derived = await getIdTokenClaims("testuser@example.com");
    expect(derived.claims.hd).toBe("example.com");

    const overridden = await getIdTokenClaims("workspaceuser@example.com");
    expect(overridden.claims.hd).toBe("override.io");

    const consumer = await getIdTokenClaims("consumer@gmail.com");
    expect(consumer.claims.hd).toBeUndefined();

    const userinfoRes = await app.request(`${base}/oauth2/v2/userinfo`, {
      headers: { Authorization: `Bearer ${overridden.accessToken}` },
    });
    expect(userinfoRes.status).toBe(200);
    expect(((await userinfoRes.json()) as { hd?: string }).hd).toBe("override.io");
  });

  it("lists calendar resources, creates events, queries freebusy, and deletes events", async () => {
    const calendarListRes = await app.request(`${base}/calendar/v3/users/me/calendarList`, {
      headers: authHeaders(),
    });
    expect(calendarListRes.status).toBe(200);

    const calendarList = (await calendarListRes.json()) as {
      items: Array<{ id: string; summary: string; primary?: boolean }>;
    };
    expect(calendarList.items.map((calendar) => calendar.id)).toEqual(["primary", "cal_team"]);

    const eventListRes = await app.request(
      `${base}/calendar/v3/calendars/primary/events?timeMin=2025-01-10T08:00:00.000Z&timeMax=2025-01-10T10:00:00.000Z&singleEvents=true&orderBy=startTime&q=${encodeURIComponent("kickoff")}`,
      { headers: authHeaders() },
    );
    expect(eventListRes.status).toBe(200);

    const eventList = (await eventListRes.json()) as {
      items: Array<{ id: string; summary: string; hangoutLink?: string }>;
    };
    expect(eventList.items).toHaveLength(1);
    expect(eventList.items[0]).toMatchObject({
      id: "evt_kickoff",
      summary: "Project Kickoff",
      hangoutLink: "https://meet.google.com/project-kickoff",
    });

    const createEventRes = await jsonRequest(app, "/calendar/v3/calendars/primary/events", {
      method: "POST",
      body: {
        summary: "Focus Time",
        description: "Block time for implementation.",
        start: { dateTime: "2025-01-10T12:00:00.000Z" },
        end: { dateTime: "2025-01-10T13:00:00.000Z" },
        attendees: [{ email: "teammate@example.com", displayName: "Teammate" }],
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/focus-time" }],
        },
      },
    });
    expect(createEventRes.status).toBe(200);
    const createdEvent = (await createEventRes.json()) as { id: string; summary: string };
    expect(createdEvent.summary).toBe("Focus Time");

    const freeBusyRes = await jsonRequest(app, "/calendar/v3/freeBusy", {
      method: "POST",
      body: {
        timeMin: "2025-01-10T11:00:00.000Z",
        timeMax: "2025-01-10T14:00:00.000Z",
        items: [{ id: "primary" }],
      },
    });
    expect(freeBusyRes.status).toBe(200);
    const freeBusyBody = (await freeBusyRes.json()) as {
      calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
    };
    expect(freeBusyBody.calendars.primary.busy).toEqual([
      {
        start: "2025-01-10T12:00:00.000Z",
        end: "2025-01-10T13:00:00.000Z",
      },
    ]);

    const deleteEventRes = await app.request(`${base}/calendar/v3/calendars/primary/events/${createdEvent.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteEventRes.status).toBe(204);

    const afterDeleteRes = await app.request(
      `${base}/calendar/v3/calendars/primary/events?timeMin=2025-01-10T11:00:00.000Z&timeMax=2025-01-10T14:00:00.000Z&q=${encodeURIComponent("Focus Time")}`,
      { headers: authHeaders() },
    );
    expect(afterDeleteRes.status).toBe(200);
    const afterDelete = (await afterDeleteRes.json()) as { items: Array<{ id: string }> };
    expect(afterDelete.items).toEqual([]);
  });

  it("lists drive files, uploads media, downloads content, and moves files", async () => {
    const listRootFoldersRes = await app.request(
      `${base}/drive/v3/files?q=${encodeURIComponent("'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false")}`,
      { headers: authHeaders() },
    );
    expect(listRootFoldersRes.status).toBe(200);
    const rootFolders = (await listRootFoldersRes.json()) as {
      files: Array<{ id: string; name: string; mimeType: string }>;
    };
    expect(rootFolders.files).toHaveLength(1);
    expect(rootFolders.files[0]).toMatchObject({
      id: "drv_docs",
      name: "Docs",
      mimeType: "application/vnd.google-apps.folder",
    });

    const fileRes = await app.request(`${base}/drive/v3/files/drv_handbook?fields=id,name,parents`, {
      headers: authHeaders(),
    });
    expect(fileRes.status).toBe(200);
    const fileBody = (await fileRes.json()) as { id: string; parents: string[] };
    expect(fileBody.id).toBe("drv_handbook");
    expect(fileBody.parents).toEqual(["drv_docs"]);

    const mediaRes = await app.request(`${base}/drive/v3/files/drv_handbook?alt=media`, {
      headers: authHeaders(),
    });
    expect(mediaRes.status).toBe(200);
    expect(Buffer.from(await mediaRes.arrayBuffer()).toString("utf8")).toBe("pdf-handbook-data");

    const createFolderRes = await jsonRequest(app, "/drive/v3/files", {
      method: "POST",
      body: {
        name: "Reports",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      },
    });
    expect(createFolderRes.status).toBe(200);
    const folder = (await createFolderRes.json()) as { id: string; mimeType: string };
    expect(folder.mimeType).toBe("application/vnd.google-apps.folder");

    const boundary = "drive-upload-boundary";
    const uploadedContent = "  fake pdf bytes \nsecond line\n";
    const multipartBody = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
        name: "Quarterly Report.pdf",
        parents: ["root"],
      })}\r\n`,
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n${uploadedContent}\r\n`,
      `--${boundary}--\r\n`,
    ].join("");

    const uploadRes = await app.request(`${base}/upload/drive/v3/files?uploadType=multipart`, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": `multipart/related; boundary=${boundary}`,
      }),
      body: multipartBody,
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { id: string; parents: string[] };
    expect(uploaded.parents).toEqual(["root"]);

    const moveRes = await jsonRequest(
      app,
      `/drive/v3/files/${uploaded.id}?addParents=${folder.id}&removeParents=root&fields=id,parents`,
      {
        method: "PATCH",
        body: {},
      },
    );
    expect(moveRes.status).toBe(200);
    const moved = (await moveRes.json()) as { parents: string[] };
    expect(moved.parents).toEqual([folder.id]);

    const movedListRes = await app.request(
      `${base}/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and (mimeType = 'application/pdf') and trashed = false`)}`,
      { headers: authHeaders() },
    );
    expect(movedListRes.status).toBe(200);
    const movedList = (await movedListRes.json()) as { files: Array<{ id: string }> };
    expect(movedList.files.map((file) => file.id)).toEqual([uploaded.id]);

    const uploadedMediaRes = await app.request(`${base}/drive/v3/files/${uploaded.id}?alt=media`, {
      headers: authHeaders(),
    });
    expect(uploadedMediaRes.status).toBe(200);
    expect(Buffer.from(await uploadedMediaRes.arrayBuffer()).toString("utf8")).toBe(uploadedContent);
  });
});
