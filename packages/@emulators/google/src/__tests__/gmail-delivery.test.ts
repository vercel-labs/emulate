import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";
import { buildRawMessage } from "../helpers.js";

const base = "http://localhost:4000";
const users = { alice: "alice@example.com", bob: "bob@example.com", carol: "carol@example.com" };

interface MessageResource {
  id: string;
  threadId: string;
  labelIds: string[];
  raw?: string;
  payload?: { headers: Array<{ name: string; value: string }> };
}

function fixture() {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  for (const [name, email] of Object.entries(users)) tokens.set(`${name}-token`, { login: email, id: 1, scopes: [] });
  app.use("*", authMiddleware(tokens));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, { users: Object.values(users).map((email) => ({ email })) });

  async function call(user: keyof typeof users, method: string, path: string, body?: unknown) {
    const res = await app.request(`${base}/gmail/v1/users/me${path}`, {
      method,
      headers: { Authorization: `Bearer ${user}-token`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status, `${method} ${path}`).toBe(200);
    return res.json() as Promise<any>;
  }

  async function inbox(user: keyof typeof users): Promise<MessageResource[]> {
    const list = (await call(user, "GET", "/messages?labelIds=INBOX")) as { messages?: Array<{ id: string }> };
    return Promise.all((list.messages ?? []).map((m) => call(user, "GET", `/messages/${m.id}`)));
  }

  const header = (message: MessageResource, name: string) =>
    message.payload?.headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;

  return { call, inbox, header };
}

function raw(fields: Parameters<typeof buildRawMessage>[0]): string {
  return buildRawMessage(fields);
}

describe("Gmail delivery of sent messages", () => {
  it("delivers messages.send to To, Cc, and Bcc users as unread inbox mail without the Bcc header", async () => {
    const { call, inbox, header } = fixture();
    const sent = (await call("alice", "POST", "/messages/send", {
      raw: raw({
        from: users.alice,
        to: `Bob <${users.bob}>, outside@elsewhere.test`,
        bcc: `"Carol, via Bcc" <${users.carol.toUpperCase()}>`,
        subject: "Quarterly numbers",
        body_text: "Attached below.",
      }),
    })) as MessageResource;
    expect(sent.labelIds).toEqual(["SENT"]);

    const [bobCopy] = await inbox("bob");
    const [carolCopy] = await inbox("carol");
    for (const copy of [bobCopy, carolCopy]) {
      expect(copy.id).not.toBe(sent.id);
      expect(copy.labelIds.sort()).toEqual(["INBOX", "UNREAD"]);
      expect(header(copy, "Subject")).toBe("Quarterly numbers");
      expect(header(copy, "Bcc")).toBeUndefined();
      const rawCopy = (await call(copy === bobCopy ? "bob" : "carol", "GET", `/messages/${copy.id}?format=raw`)) as {
        raw: string;
      };
      expect(Buffer.from(rawCopy.raw, "base64url").toString("utf8")).not.toMatch(/^bcc:/im);
    }
    expect(await inbox("alice")).toEqual([]);

    // The sender's copy keeps its Bcc header.
    const sentFull = (await call("alice", "GET", `/messages/${sent.id}`)) as MessageResource;
    expect(header(sentFull, "Bcc")).toContain(users.carol.toUpperCase());
  });

  it("delivers structured sends and drafts.send, and threads replies in the recipient's mailbox", async () => {
    const { call, inbox, header } = fixture();
    const first = (await call("alice", "POST", "/messages/send", {
      to: users.bob,
      subject: "Lunch?",
      body_text: "Noon works.",
    })) as MessageResource;
    const [received] = await inbox("bob");
    expect(header(received, "Subject")).toBe("Lunch?");
    const messageId = header(received, "Message-ID")!;
    expect(messageId).toBe(
      header((await call("alice", "GET", `/messages/${first.id}`)) as MessageResource, "Message-ID"),
    );

    const draft = (await call("bob", "POST", "/drafts", {
      message: {
        raw: raw({
          from: users.bob,
          to: users.alice,
          subject: "Re: Lunch?",
          body_text: "See you then.",
          in_reply_to: messageId,
          references: messageId,
        }),
      },
    })) as { id: string };
    const reply = (await call("bob", "POST", "/drafts/send", { id: draft.id })) as MessageResource;
    expect(reply.threadId).toBe(received.threadId);
    expect(reply.labelIds).toEqual(["SENT"]);

    const [aliceCopy] = await inbox("alice");
    expect(aliceCopy.labelIds.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(aliceCopy.threadId).toBe(first.threadId);
    const thread = (await call("alice", "GET", `/threads/${first.threadId}`)) as { messages: MessageResource[] };
    expect(thread.messages).toHaveLength(2);
  });

  it("labels a message sent to oneself SENT, INBOX, and UNREAD without a second copy", async () => {
    const { call, inbox } = fixture();
    const sent = (await call("alice", "POST", "/messages/send", {
      to: users.alice,
      cc: users.alice,
      subject: "Note to self",
      body_text: "Buy milk.",
    })) as MessageResource;
    expect(sent.labelIds.sort()).toEqual(["INBOX", "SENT", "UNREAD"]);
    const delivered = await inbox("alice");
    expect(delivered.map((message) => message.id)).toEqual([sent.id]);
  });

  it("applies the recipient's filters to the delivered copy", async () => {
    const { call, inbox } = fixture();
    await call("bob", "POST", "/settings/filters", {
      criteria: { from: users.alice },
      action: { removeLabelIds: ["INBOX", "UNREAD"] },
    });
    await call("alice", "POST", "/messages/send", { to: users.bob, subject: "FYI", body_text: "No action." });
    expect(await inbox("bob")).toEqual([]);
    const all = (await call("bob", "GET", "/messages")) as { messages: Array<{ id: string }> };
    expect(all.messages).toHaveLength(1);
  });

  it("removes a folded Bcc header and keeps the body of a raw MIME message", async () => {
    const { call, inbox } = fixture();
    const mime = [
      `From: ${users.alice}`,
      `To: ${users.bob}`,
      "Subject: Folded",
      `Bcc: someone@elsewhere.test,`,
      ` ${users.carol}`,
      "",
      "Body line one",
      "",
      "Body line two",
    ].join("\r\n");
    await call("alice", "POST", "/messages/send", { raw: Buffer.from(mime).toString("base64url") });
    for (const user of ["bob", "carol"] as const) {
      const [copy] = await inbox(user);
      const rawCopy = (await call(user, "GET", `/messages/${copy.id}?format=raw`)) as { raw: string };
      expect(Buffer.from(rawCopy.raw, "base64url").toString("utf8")).toBe(
        [`From: ${users.alice}`, `To: ${users.bob}`, "Subject: Folded", "", "Body line one", "", "Body line two"].join(
          "\r\n",
        ),
      );
    }
  });

  it("does not deliver inserted or imported messages", async () => {
    const { call, inbox } = fixture();
    const message = { raw: raw({ from: users.alice, to: users.bob, subject: "Archived", body_text: "Old mail." }) };
    await call("alice", "POST", "/messages", message);
    await call("alice", "POST", "/messages/import", message);
    expect(await inbox("bob")).toEqual([]);
  });
});
