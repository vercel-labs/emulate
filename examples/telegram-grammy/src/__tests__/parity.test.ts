/**
 * Parity test: this grammY bot runs unchanged against the Telegram emulator,
 * just like it would against real Telegram. The handlers file never learns
 * about either backend — grammY gets its apiRoot from env, that's all.
 *
 * If this test passes end-to-end through the emulator, and the same bot
 * responds identically when pointed at real Telegram, the emulator's Bot API
 * surface is faithful enough for day-to-day bot development.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono, serve, Store, WebhookDispatcher, authMiddleware, type AppEnv } from "@emulators/core";
import { telegramPlugin } from "@emulators/telegram";
import { createTelegramTestClient } from "@emulators/telegram/test";
import { Bot } from "grammy";
import { registerHandlers } from "../handlers.js";
import type { AddressInfo } from "net";

describe("grammY demo bot runs against Telegram emulator (parity)", () => {
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let bot: Bot;
  let store: Store;

  // IDs we'll reuse across tests
  let botToken: string;
  let userId: number;
  let chatId: number;

  beforeAll(async () => {
    // 1. Boot emulator in-process on an OS-picked port.
    store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(new Map()));
    telegramPlugin.register(app, store, webhooks, "http://localhost", new Map());
    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    // 2. Provision world via test client.
    const tg = createTelegramTestClient(baseUrl);
    const b = await tg.createBot({
      username: "grammy_demo_bot",
      first_name: "Demo Bot",
    });
    const u = await tg.createUser({ first_name: "Alice", username: "alice" });
    const c = await tg.createPrivateChat({ botId: b.bot_id, userId: u.id });
    botToken = b.token;
    userId = u.id;
    chatId = c.id;

    // 3. Start the grammY bot pointed at the emulator.
    //    Same handlers file that production uses — we only swap apiRoot.
    bot = new Bot(botToken, {
      client: { apiRoot: baseUrl },
    });
    registerHandlers(bot);
    bot.catch((e) => console.error("bot error:", e));
    await bot.init();
    // Start long-polling loop in background
    void bot.start({ onStart: () => {} });
    await new Promise((r) => setTimeout(r, 20));
  });

  afterAll(async () => {
    // bot.stop() calls getUpdates one last time to cancel the polling
    // loop. With real-Telegram concurrent-poll semantics, the
    // outstanding long-poll returns 409 and grammY surfaces that as
    // an error during shutdown. Swallow it — the loop is already
    // winding down.
    await bot.stop().catch((err: unknown) => {
      if (err instanceof Error && /409/.test(err.message)) return;
      throw err;
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // `expectedReplies` is how many bot messages the handler under test commits.
  // Waiting on the exact count keeps each test as fast as the handler itself —
  // the generous timeout is only a ceiling for handlers that sleep between steps
  // (/stream, /revise, /oops), never a fixed cost.
  async function simulateUserText(text: string, expectedReplies = 1): Promise<void> {
    const tg = createTelegramTestClient(baseUrl);
    await tg.sendUserMessage({ chatId, userId, text });
    await waitFor(
      () => getBotReplies().length >= replyCursor + expectedReplies,
      8000,
      `${expectedReplies} reply/replies to ${text}`,
    );
  }

  async function simulateUserPhoto(bytes: Buffer, caption?: string): Promise<string> {
    const tg = createTelegramTestClient(baseUrl);
    const res = await tg.sendUserPhoto({ chatId, userId, photoBytes: bytes, caption });
    await waitFor(() => getBotReplies().length >= replyCursor + 2, 3000, "photo ack + echo");
    return res.file_id;
  }

  async function simulateCallback(messageId: number, data: string): Promise<void> {
    const tg = createTelegramTestClient(baseUrl);
    await tg.clickInlineButton({ chatId, userId, messageId, callbackData: data });
    await waitFor(() => getBotReplies().length > replyCursor, 2000, "callback reply");
  }

  interface StoredMessage {
    id: number;
    created_at: string;
    updated_at: string;
    chat_id: number;
    from_bot_id: number | null;
    message_id: number;
    text?: string;
    reply_markup?: unknown;
    photo?: unknown[];
  }

  function getBotReplies(): StoredMessage[] {
    return store
      .collection<StoredMessage>("telegram.messages")
      .all()
      .filter((m) => m.chat_id === chatId && m.from_bot_id !== null)
      .sort((a, b) => a.message_id - b.message_id);
  }

  let replyCursor = 0;
  function snapshotCursor() {
    replyCursor = getBotReplies().length;
  }

  it("/start returns a greeting", async () => {
    snapshotCursor();
    await simulateUserText("/start");
    const replies = getBotReplies().slice(replyCursor);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toMatch(/emulate demo bot/i);
  });

  it("/echo repeats its argument", async () => {
    snapshotCursor();
    await simulateUserText("/echo hello world");
    const replies = getBotReplies().slice(replyCursor);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("hello world");
  });

  it("/menu sends a message with inline keyboard", async () => {
    snapshotCursor();
    await simulateUserText("/menu");
    const replies = getBotReplies().slice(replyCursor);
    expect(replies).toHaveLength(1);
    const kb = replies[0].reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual(["opt:a", "opt:b"]);
  });

  it("callback query from inline button triggers answerCallbackQuery + editMessageReplyMarkup + reply", async () => {
    snapshotCursor();
    await simulateUserText("/menu");
    const menuReplies = getBotReplies();
    const menuMessage = menuReplies[menuReplies.length - 1];

    snapshotCursor();
    await simulateCallback(menuMessage.message_id, "opt:a");

    // Wait for the edit + reply to propagate (edit is an API call; reply inserts a row).
    await waitFor(() => getBotReplies().length > replyCursor, 3000, "callback reply");

    const after = getBotReplies().slice(replyCursor);
    expect(after.some((m) => m.text === "You picked A.")).toBe(true);
  });

  it("photo message: bot acknowledges and echoes via file_id", async () => {
    snapshotCursor();
    const PNG_1X1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQIW2P4//8/AAX+Av4zhb9VAAAAAElFTkSuQmCC",
      "base64",
    );
    await simulateUserPhoto(PNG_1X1, "check this");

    const replies = getBotReplies().slice(replyCursor);
    expect(replies.length).toBeGreaterThanOrEqual(2);

    const ack = replies.find((r) => r.text?.startsWith("Got a photo"));
    expect(ack).toBeDefined();
    expect(ack!.text).toContain("check this");

    const echo = replies.find((r) => Array.isArray(r.photo));
    expect(echo).toBeDefined();
  });

  it("plain text falls through to the default handler", async () => {
    snapshotCursor();
    await simulateUserText("not a command");
    const replies = getBotReplies().slice(replyCursor);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("You said: not a command");
  });

  // Phase 2 flows — sendMessageDraft, editMessageText, deleteMessage.

  it("/stream pushes multiple draft snapshots then commits a final message", async () => {
    snapshotCursor();
    const draftsBefore = store.collection("telegram.draft_snapshots").all().length;
    await simulateUserText("/stream");
    await waitFor(
      () => store.collection("telegram.draft_snapshots").all().length - draftsBefore === 5,
      8000,
      "5 draft snapshots",
    );

    const replies = getBotReplies().slice(replyCursor);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[replies.length - 1].text).toContain("Tangier");

    const draftsAfter = store.collection("telegram.draft_snapshots").all().length;
    expect(draftsAfter - draftsBefore).toBe(5);
  });

  it("/revise edits the bot's own message in place (edited_date set)", async () => {
    snapshotCursor();
    await simulateUserText("/revise");
    await waitFor(
      () => {
        const r = getBotReplies().slice(replyCursor);
        return r.length >= 1 && (r[0] as { edited_date?: number }).edited_date !== undefined;
      },
      5000,
      "edited reply",
    );
    const reply = getBotReplies().slice(replyCursor)[0] as { text?: string; edited_date?: number };
    expect(reply.text).toBe("Final reply: done!");
    expect(reply.edited_date).toBeGreaterThan(0);
  });

  it("/oops deletes the previous message and sends a follow-up", async () => {
    snapshotCursor();
    await simulateUserText("/oops", 2);

    const allInRange = store
      .collection<{
        id: number;
        created_at: string;
        updated_at: string;
        chat_id: number;
        from_bot_id: number | null;
        message_id: number;
        text?: string;
        deleted?: boolean;
      }>("telegram.messages")
      .all()
      .filter((m) => m.chat_id === chatId && m.from_bot_id !== null)
      .sort((a, b) => a.message_id - b.message_id)
      .slice(replyCursor);

    expect(allInRange.length).toBeGreaterThanOrEqual(2);
    expect(allInRange[0].deleted).toBe(true);
    expect(allInRange[0].text).toBe("This message will self-destruct.");
    expect(allInRange[allInRange.length - 1].text).toBe("Deleted the previous message.");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
