import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, postJson, json, type TestApp } from "./helpers.js";
import { getTelegramStore } from "../store.js";
import {
  createBot,
  createGroupChat,
  createPrivateChat,
  createUser,
  simulateCallback,
  simulateUserMessage,
} from "../routes/control.js";
import type { WireMessage, WireUpdate } from "../types/wire/index.js";

describe("Telegram Bot API - getMe", () => {
  let tx: TestApp;

  beforeEach(() => {
    tx = createTestApp();
  });

  it("returns bot identity for a valid token", async () => {
    const bot = getTelegramStore(tx.store).bots.all()[0]!;
    const res = await postJson(tx.app, `/bot${bot.token}/getMe`, {});
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      result: { id: number; is_bot: boolean; username: string };
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.result.id).toBe(bot.bot_id);
    expect(body.result.is_bot).toBe(true);
    expect(body.result.username).toBe("emulate_bot");
  });

  it("rejects invalid token with 401", async () => {
    const res = await postJson(tx.app, "/bot999:BAD/getMe", {});
    expect(res.status).toBe(401);
    const body = await json<{ ok: boolean; error_code: number }>(res);
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe(401);
  });
});

describe("Telegram Bot API - sendMessage / DM round-trip", () => {
  let tx: TestApp;

  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("bot can send a message into a private chat it participates in", async () => {
    const bot = createBot(tx.store, { username: "trip_test_bot", first_name: "Trip Test" });
    const user = createUser(tx.store, { first_name: "Alice" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "hello there",
    });

    const body = await json<{ ok: boolean; result: WireMessage }>(res);
    expect(body.ok).toBe(true);
    const msg = body.result;
    expect(msg.text).toBe("hello there");
    expect(msg.message_id).toBe(1);
    expect(msg.chat.id).toBe(dm.chat_id);
    expect(msg.from?.id).toBe(bot.bot_id);
  });

  it("rejects sendMessage to a chat the bot is not a member of", async () => {
    const bot = createBot(tx.store, { username: "bot1" });
    // Chat not containing this bot
    const user = createUser(tx.store, { first_name: "Alice" });
    const otherBot = createBot(tx.store, { username: "other_bot" });
    const dm = createPrivateChat(tx.store, { botId: otherBot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "sneaky",
    });
    expect(res.status).toBe(403);
  });
});

describe("Telegram Bot API - getUpdates (long polling)", () => {
  let tx: TestApp;

  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("returns queued user message as a message Update", async () => {
    const bot = createBot(tx.store, { username: "trip_test_bot" });
    const user = createUser(tx.store, { first_name: "Alice" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "hello from alice" });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    const body = await json<{ ok: boolean; result: WireUpdate[] }>(res);
    expect(body.ok).toBe(true);
    expect(body.result.length).toBe(1);
    const upd = body.result[0];
    expect(upd.update_id).toBe(1);
    if (!("message" in upd)) throw new Error("expected message update");
    expect(upd.message.text).toBe("hello from alice");
    expect(upd.message.from?.id).toBe(user.user_id);
  });

  it("offset confirms prior updates so they don't come back", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "one" });
    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "two" });

    const first = await json<{ result: Array<{ update_id: number }> }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}),
    );
    expect(first.result.length).toBe(2);

    const confirmed = await json<{ result: Array<{ update_id: number }> }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, { offset: first.result.at(-1)!.update_id + 1 }),
    );
    expect(confirmed.result.length).toBe(0);
  });

  it("rejects getUpdates while webhook is active (409)", async () => {
    const bot = createBot(tx.store, { username: "b" });
    // Activate webhook
    await postJson(tx.app, `/bot${bot.token}/setWebhook`, { url: "https://example.com/webhook" });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    expect(res.status).toBe(409);
  });

  it("setWebhook rejects non-HTTPS URLs with 400", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const res = await postJson(tx.app, `/bot${bot.token}/setWebhook`, {
      url: "http://example.com/webhook",
    });
    expect(res.status).toBe(400);
    const body = await json<{ description: string }>(res);
    expect(body.description).toMatch(/HTTPS/);
  });

  it("sendMessage rejects reply_to_message_id pointing at a non-existent message", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "reply to ghost",
      reply_to_message_id: 9999,
    });
    expect(res.status).toBe(400);
    const body = await json<{ description: string }>(res);
    expect(body.description).toMatch(/replied not found/);
  });

  it("accepts legacy parse_mode=Markdown", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "*bold* and _italic_",
      parse_mode: "Markdown",
    });
    expect(res.status).toBe(200);
    const body = await json<{ result: { text: string; entities: Array<{ type: string }> } }>(res);
    expect(body.result.text).toBe("bold and italic");
    expect(body.result.entities.map((e) => e.type).sort()).toEqual(["bold", "italic"]);
  });

  it("setWebhook / deleteWebhook / setMyCommands return bare true", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const set = await json<{ ok: boolean; result: unknown }>(
      await postJson(tx.app, `/bot${bot.token}/setWebhook`, { url: "https://example.com/webhook" }),
    );
    expect(set.result).toBe(true);

    const del = await json<{ ok: boolean; result: unknown }>(
      await postJson(tx.app, `/bot${bot.token}/deleteWebhook`, {}),
    );
    expect(del.result).toBe(true);

    const cmd = await json<{ ok: boolean; result: unknown }>(
      await postJson(tx.app, `/bot${bot.token}/setMyCommands`, {
        commands: [{ command: "start", description: "Start" }],
      }),
    );
    expect(cmd.result).toBe(true);
  });

  it("a new long-poll terminates a prior long-poll with 409 (takeover)", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const first = postJson(tx.app, `/bot${bot.token}/getUpdates`, { timeout: 2 });
    // Yield so the first request registers its long-poll waiter.
    await new Promise((r) => setImmediate(r));
    const second = postJson(tx.app, `/bot${bot.token}/getUpdates`, { timeout: 1 });
    // Yield again so the takeover can resolve the first.
    await new Promise((r) => setImmediate(r));
    const oldRes = await first;
    expect(oldRes.status).toBe(409);
    const newRes = await second;
    // The new poll also times out without updates but returns 200.
    expect(newRes.status).toBe(200);
  }, 4000);
});

describe("Telegram Bot API - commands and entities", () => {
  let tx: TestApp;

  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("parses /command as bot_command entity", async () => {
    const bot = createBot(tx.store, { username: "trip_bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "/connect ABC" });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    const body = await json<{ result: Array<{ message: { entities: Array<{ type: string; offset: number; length: number }> } }> }>(res);
    const entities = body.result[0].message.entities;
    expect(entities).toHaveLength(1);
    expect(entities[0].type).toBe("bot_command");
    expect(entities[0].offset).toBe(0);
    expect(entities[0].length).toBe("/connect".length);
  });

  it("parses /command@botname addressed to specific bot", async () => {
    const botA = createBot(tx.store, { username: "bot_a" });
    const botB = createBot(tx.store, { username: "bot_b" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [user.user_id],
      botIds: [botA.bot_id, botB.bot_id],
    });

    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "/help@bot_a" });

    // Only bot_a receives it, bot_b does not
    const aRes = await json<{ result: unknown[] }>(await postJson(tx.app, `/bot${botA.token}/getUpdates`, {}));
    const bRes = await json<{ result: unknown[] }>(await postJson(tx.app, `/bot${botB.token}/getUpdates`, {}));
    expect(aRes.result).toHaveLength(1);
    expect(bRes.result).toHaveLength(0);
  });
});

describe("Telegram Bot API - mentions in groups", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("bot only sees group messages that mention it", async () => {
    const bot = createBot(tx.store, { username: "trip_bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [user.user_id],
      botIds: [bot.bot_id],
    });

    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "chatting to the group" });
    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "hi @trip_bot, what's the plan?" });

    const updates = await json<{ result: Array<{ message: { text: string } }> }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}),
    );
    expect(updates.result).toHaveLength(1);
    expect(updates.result[0].message.text).toContain("@trip_bot");
  });

  it("privacy-mode bot does NOT receive bare /command without @mention", async () => {
    const bot = createBot(tx.store, { username: "quiet_bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [user.user_id],
      botIds: [bot.bot_id],
    });

    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "/help" });
    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "/help@quiet_bot" });

    const updates = await json<{ result: Array<{ message: { text: string } }> }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}),
    );
    expect(updates.result).toHaveLength(1);
    expect(updates.result[0].message.text).toBe("/help@quiet_bot");
  });

  it("can_read_all_group_messages bot sees every message", async () => {
    const bot = createBot(tx.store, { username: "greedy_bot", can_read_all_group_messages: true });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, { title: "G", memberIds: [user.user_id], botIds: [bot.bot_id] });

    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "one" });
    simulateUserMessage(tx.store, { chatId: group.chat_id, userId: user.user_id, text: "two" });

    const updates = await json<{ result: unknown[] }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}),
    );
    expect(updates.result).toHaveLength(2);
  });
});

describe("Telegram Bot API - photos and file_id round-trip", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("bot can sendPhoto by file_id and getFile, then download bytes", async () => {
    const bot = createBot(tx.store, { username: "bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    // User sends a photo via control plane
    const photoBase64 = Buffer.from(PNG_1X1).toString("base64");
    const upl = await postJson(tx.app, `/_emu/telegram/chats/${dm.chat_id}/photos`, {
      userId: user.user_id,
      photoBase64,
      caption: "nice",
    });
    const { file_id } = await json<{ file_id: string }>(upl);
    expect(file_id).toMatch(/^tg_emu_/);

    // Bot resolves file via getFile
    const fileRes = await json<{ result: { file_path: string } }>(
      await postJson(tx.app, `/bot${bot.token}/getFile`, { file_id }),
    );
    expect(fileRes.result.file_path).toContain("photos/");

    // Bot downloads bytes
    const dl = await tx.app.request(`http://localhost:4011/file/bot${bot.token}/${fileRes.result.file_path}`);
    expect(dl.status).toBe(200);
    const buf = Buffer.from(await dl.arrayBuffer());
    expect(buf.equals(Buffer.from(PNG_1X1))).toBe(true);

    // Bot re-sends by file_id
    const send = await postJson(tx.app, `/bot${bot.token}/sendPhoto`, {
      chat_id: dm.chat_id,
      photo: file_id,
      caption: "echo",
    });
    const sent = await json<{ ok: boolean; result: { photo: unknown[] } }>(send);
    expect(sent.ok).toBe(true);
    expect(Array.isArray(sent.result.photo)).toBe(true);
  });
});

describe("Telegram Bot API - callback queries + inline keyboards", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("user click on inline button yields callback_query Update, bot can answerCallbackQuery", async () => {
    const bot = createBot(tx.store, { username: "bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    // Bot sends a message with inline keyboard
    const sendRes = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "Confirm?",
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "confirm:yes" }]] },
    });
    const sent = await json<{ result: { message_id: number } }>(sendRes);
    const messageId = sent.result.message_id;

    // Simulate click via programmatic helper
    const { update_id } = simulateCallback(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      messageId,
      callbackData: "confirm:yes",
    });
    expect(update_id).toBeGreaterThan(0);

    // Bot polls and sees the callback
    const updates = await json<{
      result: Array<{ callback_query?: { id: string; data: string } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    expect(updates.result[0].callback_query?.data).toBe("confirm:yes");
    const cqId = updates.result[0].callback_query!.id;

    // Bot answers
    const ack = await postJson(tx.app, `/bot${bot.token}/answerCallbackQuery`, {
      callback_query_id: cqId,
      text: "Confirmed",
    });
    expect(ack.status).toBe(200);
  });
});

// 1x1 red PNG (89 bytes)
const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x07, 0xe8, 0xd7,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
