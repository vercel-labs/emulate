import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const users = ["alice@example.com", "bob@example.com", "carol@example.com", "dave@example.com"];

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  users.forEach((email, index) => tokenMap.set(`token-${email}`, { login: email, id: index + 1, scopes: [] }));

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  googlePlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, { users: users.map((email) => ({ email })) });
  return app;
}

function encode(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

describe("Gmail delivery of sent messages", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  async function call(user: string, method: string, path: string, body?: unknown) {
    const res = await app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer token-${user}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as any };
  }

  async function inbox(user: string) {
    const list = await call(user, "GET", "/gmail/v1/users/me/messages?labelIds=INBOX");
    return Promise.all(
      (list.body.messages ?? []).map(
        async (ref: { id: string }) =>
          (await call(user, "GET", `/gmail/v1/users/me/messages/${ref.id}?format=raw`)).body,
      ),
    );
  }

  function header(raw: string, name: string): string | undefined {
    const head = Buffer.from(raw, "base64url")
      .toString("utf8")
      .split(/\r?\n\r?\n/)[0];
    return head.match(new RegExp(`^${name}: (.*)$`, "im"))?.[1];
  }

  it("delivers to the To, Cc and Bcc recipients who are users, without the Bcc header", async () => {
    const raw = encode([
      "From: Alice <alice@example.com>",
      'To: "Bob, the builder" <bob@example.com>, outside@elsewhere.test',
      "Cc: carol@example.com",
      "Bcc: dave@example.com,",
      " other@elsewhere.test",
      "Subject: Rounds",
      "Message-ID: <rounds-1@example.com>",
      "",
      "See you at nine.",
    ]);
    const sent = await call("alice@example.com", "POST", "/gmail/v1/users/me/messages/send", { raw });
    expect(sent.status).toBe(200);
    expect(sent.body.labelIds).toEqual(["SENT"]);

    for (const recipient of ["bob@example.com", "carol@example.com", "dave@example.com"]) {
      const messages = await inbox(recipient);
      expect(messages).toHaveLength(1);
      expect(messages[0].labelIds).toEqual(["INBOX", "UNREAD"]);
      expect(messages[0].id).not.toBe(sent.body.id);
      expect(header(messages[0].raw, "Message-ID")).toBe("<rounds-1@example.com>");
      expect(header(messages[0].raw, "Bcc")).toBeUndefined();
      expect(Buffer.from(messages[0].raw, "base64url").toString()).toContain("See you at nine.");
    }

    const own = await call("alice@example.com", "GET", `/gmail/v1/users/me/messages/${sent.body.id}?format=raw`);
    expect(header(own.body.raw, "Bcc")).toBe("dave@example.com,");
  });

  it("labels the sender's own message INBOX and UNREAD when the sender is a recipient, without a second copy", async () => {
    const raw = encode([
      "From: alice@example.com",
      "To: bob@example.com",
      "Cc: Alice@Example.com",
      "Subject: Note",
      "",
      "Hi.",
    ]);
    const sent = await call("alice@example.com", "POST", "/gmail/v1/users/me/messages/send", { raw });
    expect(sent.status).toBe(200);
    expect([...sent.body.labelIds].sort()).toEqual(["INBOX", "SENT", "UNREAD"]);

    const all = await call("alice@example.com", "GET", "/gmail/v1/users/me/messages");
    expect(all.body.messages.map((ref: { id: string }) => ref.id)).toEqual([sent.body.id]);
    const [own] = await inbox("alice@example.com");
    expect(own.id).toBe(sent.body.id);
    expect([...own.labelIds].sort()).toEqual(["INBOX", "SENT", "UNREAD"]);
    expect(await inbox("bob@example.com")).toHaveLength(1);

    const draft = await call("carol@example.com", "POST", "/gmail/v1/users/me/drafts", {
      message: { raw: encode(["From: carol@example.com", "To: carol@example.com", "Subject: Reminder", "", "Later."]) },
    });
    const sentDraft = await call("carol@example.com", "POST", "/gmail/v1/users/me/drafts/send", { id: draft.body.id });
    expect([...sentDraft.body.labelIds].sort()).toEqual(["INBOX", "SENT", "UNREAD"]);
    const carol = await inbox("carol@example.com");
    expect(carol.map((message) => message.id)).toEqual([sentDraft.body.id]);
  });

  it("delivers messages built from fields, and threads replies in each mailbox", async () => {
    const first = await call("alice@example.com", "POST", "/gmail/v1/users/me/messages/send", {
      to: "bob@example.com",
      subject: "Shift swap",
      body_text: "Can you take Friday?",
    });
    const [received] = await inbox("bob@example.com");
    const messageId = header(received.raw, "Message-ID");
    const own = await call("alice@example.com", "GET", `/gmail/v1/users/me/messages/${first.body.id}?format=raw`);
    expect(messageId).toBeDefined();
    expect(header(own.body.raw, "Message-ID")).toBe(messageId);

    const reply = encode([
      "From: bob@example.com",
      "To: alice@example.com",
      "Subject: Re: Shift swap",
      `In-Reply-To: ${messageId}`,
      `References: ${messageId}`,
      "",
      "Yes.",
    ]);
    const replied = await call("bob@example.com", "POST", "/gmail/v1/users/me/messages/send", { raw: reply });
    expect(replied.body.threadId).toBe(received.threadId);

    const [answer] = await inbox("alice@example.com");
    expect(answer.threadId).toBe(first.body.threadId);
  });

  it("delivers drafts when they are sent", async () => {
    const draft = await call("alice@example.com", "POST", "/gmail/v1/users/me/drafts", {
      message: { raw: encode(["From: alice@example.com", "To: carol@example.com", "Subject: Draft", "", "Later."]) },
    });
    expect(await inbox("carol@example.com")).toHaveLength(0);

    const sent = await call("alice@example.com", "POST", "/gmail/v1/users/me/drafts/send", { id: draft.body.id });
    expect(sent.status).toBe(200);
    const messages = await inbox("carol@example.com");
    expect(messages).toHaveLength(1);
    expect(messages[0].labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("does not deliver inserted or imported messages", async () => {
    const raw = encode(["From: alice@example.com", "To: bob@example.com", "Subject: Archive", "", "Old."]);
    expect((await call("alice@example.com", "POST", "/gmail/v1/users/me/messages", { raw })).status).toBe(200);
    expect((await call("alice@example.com", "POST", "/gmail/v1/users/me/messages/import", { raw })).status).toBe(200);
    expect(await inbox("bob@example.com")).toHaveLength(0);
  });
});
