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

  it("replaces a From address the sender can't send as with their default address", async () => {
    const { call, inbox, header } = fixture();
    const decoded = async (user: keyof typeof users, id: string) =>
      Buffer.from(
        ((await call(user, "GET", `/messages/${id}?format=raw`)) as { raw: string }).raw,
        "base64url",
      ).toString("utf8");

    const viaRaw = (await call("alice", "POST", "/messages/send", {
      raw: raw({ from: `Bob <${users.bob}>`, to: users.carol, subject: "Raw", body_text: "Hi." }),
    })) as MessageResource;
    await call("alice", "POST", "/messages/send", { from: users.bob, to: users.carol, subject: "Fields" });
    const draft = (await call("alice", "POST", "/drafts", {
      message: { raw: raw({ from: users.bob, to: users.carol, subject: "Draft", body_text: "Hi." }) },
    })) as { id: string };
    await call("alice", "POST", "/drafts/send", { id: draft.id });

    const copies = await inbox("carol");
    expect(copies.map((copy) => header(copy, "Subject")).sort()).toEqual(["Draft", "Fields", "Raw"]);
    for (const copy of copies) {
      expect(header(copy, "From")).toBe(`alice <${users.alice}>`);
      const source = await decoded("carol", copy.id);
      expect(source).toMatch(/^From: alice <alice@example\.com>\r?$/m);
      expect(source).not.toContain(users.bob);
    }
    expect(header((await call("alice", "GET", `/messages/${viaRaw.id}`)) as MessageResource, "From")).toBe(
      `alice <${users.alice}>`,
    );
    expect(await decoded("alice", viaRaw.id)).not.toContain(users.bob);

    // An address the sender owns is kept as written.
    await call("alice", "POST", "/messages/send", { from: `Alice A <ALICE@example.com>`, to: users.bob });
    const [bobCopy] = await inbox("bob");
    expect(header(bobCopy, "From")).toBe("Alice A <ALICE@example.com>");
  });

  it("parses From as a mailbox list before checking it against send-as addresses", async () => {
    const { call, inbox, header } = fixture();
    const cases = [
      // A quoted local part, which an address scan drops, leaving only the sender's own address.
      [`"bob"@example.com, ${users.alice}`, `alice <${users.alice}>`],
      // A quote inside a comment, which a scan that strips quoted strings first reads the wrong way round.
      [`(") bob@example.com (") ${users.alice}`, `alice <${users.alice}>`],
      // A nested comment around another address is only a comment, and is dropped when From is rebuilt.
      [`${users.alice} (see (also) bob@example.com)`, users.alice],
      [`"Alice, A." <${users.alice}>`, `"Alice, A." <${users.alice}>`],
    ];
    for (const [from, expected] of cases) {
      await call("alice", "POST", "/messages/send", { from, to: users.carol, subject: `fields ${from}` });
      await call("alice", "POST", "/messages/send", {
        raw: raw({ from, to: users.carol, subject: `raw ${from}`, body_text: "Hi." }),
      });
      const draft = (await call("alice", "POST", "/drafts", {
        message: { raw: raw({ from, to: users.carol, subject: `draft ${from}`, body_text: "Hi." }) },
      })) as { id: string };
      await call("alice", "POST", "/drafts/send", { id: draft.id });
      for (const kind of ["fields", "raw", "draft"]) {
        const copy = (await inbox("carol")).find((message) => header(message, "Subject") === `${kind} ${from}`)!;
        expect(header(copy, "From"), `${kind} ${from}`).toBe(expected);
        const source = Buffer.from(
          ((await call("carol", "GET", `/messages/${copy.id}?format=raw`)) as { raw: string }).raw,
          "base64url",
        ).toString("utf8");
        expect(source.match(/^From:.*$/gim), `${kind} ${from}`).toEqual([`From: ${expected}`]);
      }
    }
  });

  it("rewrites a malformed From without stalling", async () => {
    const { call, inbox, header } = fixture();
    const from = `${users.bob})`;
    const started = Date.now();
    await call("alice", "POST", "/messages/send", { from, to: users.carol, subject: "fields malformed" });
    await call("alice", "POST", "/messages/send", {
      raw: raw({ from, to: users.carol, subject: "raw malformed", body_text: "Hi." }),
    });
    const draft = (await call("alice", "POST", "/drafts", {
      message: { raw: raw({ from, to: users.carol, subject: "draft malformed", body_text: "Hi." }) },
    })) as { id: string };
    await call("alice", "POST", "/drafts/send", { id: draft.id });
    const elapsed = Date.now() - started;

    const copies = await inbox("carol");
    expect(copies.map((copy) => header(copy, "Subject")).sort()).toEqual([
      "draft malformed",
      "fields malformed",
      "raw malformed",
    ]);
    for (const copy of copies) {
      expect(header(copy, "From")).toBe(`alice <${users.alice}>`);
      const source = Buffer.from(
        ((await call("carol", "GET", `/messages/${copy.id}?format=raw`)) as { raw: string }).raw,
        "base64url",
      ).toString("utf8");
      expect(source.match(/^From:.*$/gim)).toEqual([`From: alice <${users.alice}>`]);
    }
    expect(elapsed).toBeLessThan(1000);
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

  it("applies the sender's filters to a message sent to oneself", async () => {
    const { call, inbox } = fixture();
    await call("alice", "POST", "/settings/filters", {
      criteria: { from: users.alice },
      action: { removeLabelIds: ["INBOX", "UNREAD"] },
    });
    const sent = (await call("alice", "POST", "/messages/send", {
      to: users.alice,
      subject: "Note to self",
      body_text: "Archived on arrival.",
    })) as MessageResource;
    expect(sent.labelIds).toEqual(["SENT"]);
    expect(await inbox("alice")).toEqual([]);
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
