import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@internal/core";
import { googlePlugin, seedFromConfig } from "../index.js";
import { buildRawMessage } from "../helpers.js";

const base = "http://localhost:4000";

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
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  googlePlugin.register(app as any, store, webhooks, base, tokenMap);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "testuser@example.com", name: "Test User" }],
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
  });

  return { app };
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: "Bearer test-token", ...extra };
}

async function jsonRequest(
  app: Hono,
  path: string,
  init?: RequestInit & { body?: unknown },
) {
  const headers = authHeaders({ "Content-Type": "application/json", ...(init?.headers ?? {}) });
  const body =
    init?.body === undefined || typeof init.body === "string"
      ? (init?.body as BodyInit | undefined)
      : JSON.stringify(init.body);

  return app.request(`${base}${path}`, {
    ...init,
    headers,
    body,
  });
}

describe("Google plugin integration", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
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
    expect(listBody.threads.map((thread) => thread.id)).toEqual([
      "thread_support",
      "thread_billing",
      "thread_release",
    ]);

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
});
