import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, postJson, json, type TestApp } from "./helpers.js";
import { getTelegramStore } from "../store.js";
import {
  clearFaults,
  createBot,
  createChannel,
  createForumTopic,
  createGroupChat,
  createPrivateChat,
  createSupergroup,
  createUser,
  getCallbackAnswer,
  injectFault,
  simulateCallback,
  simulateChannelPost,
  simulateReaction,
  simulateUserMedia,
  simulateUserMessage,
} from "../routes/control.js";

describe("Integration — channel posts", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("channel_post reaches bots added to the channel, with sender_chat and no from", async () => {
    const bot = createBot(tx.store, { username: "newsbot" });
    const channel = createChannel(tx.store, { title: "News", memberBotIds: [bot.bot_id] });

    simulateChannelPost(tx.store, { chatId: channel.chat_id, text: "headline" });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    const body = await json<{
      result: Array<{
        channel_post?: {
          sender_chat: { id: number; type: string; title: string };
          chat: { id: number; type: string };
          text: string;
          from?: unknown;
        };
      }>;
    }>(res);
    expect(body.result).toHaveLength(1);
    const post = body.result[0].channel_post!;
    expect(post.sender_chat).toMatchObject({ id: channel.chat_id, type: "channel", title: "News" });
    expect(post.chat).toMatchObject({ id: channel.chat_id, type: "channel" });
    expect(post.text).toBe("headline");
    expect(post.from).toBeUndefined();
  });

  it("edited_channel_post dispatches with new text", async () => {
    const bot = createBot(tx.store, { username: "newsbot" });
    const channel = createChannel(tx.store, { title: "News", memberBotIds: [bot.bot_id] });
    const { message_id } = simulateChannelPost(tx.store, { chatId: channel.chat_id, text: "v1" });
    simulateChannelPost(tx.store, { chatId: channel.chat_id, edited: true, existingMessageId: message_id, text: "v2" });

    const updates = await json<{
      result: Array<{ edited_channel_post?: { text: string } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    const edited = updates.result.find((u) => u.edited_channel_post);
    expect(edited?.edited_channel_post?.text).toBe("v2");
  });
});

describe("Integration — forum topics", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("routes message_thread_id through user → bot → reply round trip", async () => {
    const bot = createBot(tx.store, { username: "topicbot" });
    const user = createUser(tx.store, { first_name: "A" });
    const sg = createSupergroup(tx.store, { title: "SG", memberIds: [user.user_id], botIds: [bot.bot_id] });
    const { message_thread_id } = createForumTopic(tx.store, { chatId: sg.chat_id, name: "discussion" });

    simulateUserMessage(tx.store, {
      chatId: sg.chat_id,
      userId: user.user_id,
      text: "@topicbot hi",
      messageThreadId: message_thread_id,
    });

    const updates = await json<{
      result: Array<{ message: { message_thread_id?: number } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    expect(updates.result[0].message.message_thread_id).toBe(message_thread_id);

    const sent = await json<{ result: { message_thread_id?: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
        chat_id: sg.chat_id,
        message_thread_id,
        text: "hi back",
      }),
    );
    expect(sent.result.message_thread_id).toBe(message_thread_id);
  });

  it("bot can createForumTopic / editForumTopic / closeForumTopic / deleteForumTopic via Bot API", async () => {
    const bot = createBot(tx.store, { username: "fbot" });
    const user = createUser(tx.store, { first_name: "A" });
    const sg = createSupergroup(tx.store, {
      title: "SG",
      memberIds: [user.user_id],
      botIds: [bot.bot_id],
      isForum: true,
    });

    const created = await json<{ result: { message_thread_id: number; name: string; icon_color: number } }>(
      await postJson(tx.app, `/bot${bot.token}/createForumTopic`, {
        chat_id: sg.chat_id,
        name: "General",
      }),
    );
    expect(created.result.name).toBe("General");
    expect(typeof created.result.message_thread_id).toBe("number");

    const edited = await json<{ result: boolean }>(
      await postJson(tx.app, `/bot${bot.token}/editForumTopic`, {
        chat_id: sg.chat_id,
        message_thread_id: created.result.message_thread_id,
        name: "Renamed",
      }),
    );
    expect(edited.result).toBe(true);

    const closed = await json<{ result: boolean }>(
      await postJson(tx.app, `/bot${bot.token}/closeForumTopic`, {
        chat_id: sg.chat_id,
        message_thread_id: created.result.message_thread_id,
      }),
    );
    expect(closed.result).toBe(true);

    const reopened = await json<{ result: boolean }>(
      await postJson(tx.app, `/bot${bot.token}/reopenForumTopic`, {
        chat_id: sg.chat_id,
        message_thread_id: created.result.message_thread_id,
      }),
    );
    expect(reopened.result).toBe(true);

    const deleted = await json<{ result: boolean }>(
      await postJson(tx.app, `/bot${bot.token}/deleteForumTopic`, {
        chat_id: sg.chat_id,
        message_thread_id: created.result.message_thread_id,
      }),
    );
    expect(deleted.result).toBe(true);
  });

  it("rejects message_thread_id in non-supergroup chats", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      message_thread_id: 42,
      text: "nope",
    });
    expect(res.status).toBe(400);
    const body = await json<{ description: string }>(res);
    expect(body.description).toContain("message thread not found");
  });
});

describe("Integration — error shapes", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("429 with retry_after surfaced in the body", async () => {
    const bot = createBot(tx.store, { username: "b" });
    injectFault(tx.store, {
      botId: bot.bot_id,
      method: "sendMessage",
      error_code: 429,
      retry_after: 7,
    });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "x",
    });
    expect(res.status).toBe(429);
    const body = await json<{
      ok: boolean;
      error_code: number;
      description: string;
      parameters: { retry_after: number };
    }>(res);
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe(429);
    expect(body.description).toContain("Too Many Requests");
    expect(body.parameters.retry_after).toBe(7);
  });

  it("fault is consumed once, then the call succeeds", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    injectFault(tx.store, { botId: bot.bot_id, method: "sendMessage", error_code: 429, retry_after: 1 });

    const r1 = await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "a" });
    expect(r1.status).toBe(429);
    const r2 = await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "b" });
    expect(r2.status).toBe(200);
  });

  it("403 on bot not in chat stays structured", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const other = createBot(tx.store, { username: "other" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: other.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "x",
    });
    expect(res.status).toBe(403);
    const body = await json<{ ok: boolean; error_code: number }>(res);
    expect(body.error_code).toBe(403);
  });

  it("404 on unknown method", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const res = await postJson(tx.app, `/bot${bot.token}/thisMethodDoesNotExist`, {});
    expect(res.status).toBe(404);
    const body = await json<{ error_code: number }>(res);
    expect(body.error_code).toBe(404);
  });

  it("401 on unknown token", async () => {
    const res = await postJson(tx.app, "/bot999:FAKE/sendMessage", { chat_id: 1, text: "x" });
    expect(res.status).toBe(401);
  });

  it("clearFaults drops all faults", async () => {
    const bot = createBot(tx.store, { username: "b" });
    injectFault(tx.store, { botId: bot.bot_id, method: "*", error_code: 403 });
    clearFaults(tx.store);
    expect(getTelegramStore(tx.store).faults.all()).toHaveLength(0);
  });
});

describe("Integration — length caps", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("sendMessage rejects text over 4096 chars", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "a".repeat(4097),
    });
    expect(res.status).toBe(400);
    const body = await json<{ description: string }>(res);
    expect(body.description).toContain("message is too long");
  });

  it("sendMessage accepts exactly 4096 chars", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "a".repeat(4096),
    });
    expect(res.status).toBe(200);
  });

  it("editMessageText rejects text over 4096 chars", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "v1" }),
    );
    const res = await postJson(tx.app, `/bot${bot.token}/editMessageText`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      text: "a".repeat(4097),
    });
    expect(res.status).toBe(400);
  });

  it("sendPhoto rejects caption over 1024 chars", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQIW2P4//8/AAX+Av4zhb9VAAAAAElFTkSuQmCC",
      "base64",
    );
    // Upload first so we have a file_id to echo
    const up = await json<{ file_id: string }>(
      await postJson(tx.app, `/_emu/telegram/chats/${dm.chat_id}/photos`, {
        userId: user.user_id,
        photoBase64: PNG.toString("base64"),
      }),
    );
    const res = await postJson(tx.app, `/bot${bot.token}/sendPhoto`, {
      chat_id: dm.chat_id,
      photo: up.file_id,
      caption: "b".repeat(1025),
    });
    expect(res.status).toBe(400);
    const body = await json<{ description: string }>(res);
    expect(body.description).toContain("caption is too long");
  });

  it("MarkdownV2 text length is measured after stripping markup", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    // 2*2050 letters wrapped in asterisks → raw is ~4104, stripped is ~4100 > 4096
    const text = "*" + "a".repeat(4100) + "*";
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text,
      parse_mode: "MarkdownV2",
    });
    expect(res.status).toBe(400);
    expect((await json<{ description: string }>(res)).description).toContain("message is too long");
  });
});

describe("Integration — rich media", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  const cases: Array<{ method: string; field: "video" | "audio" | "voice" | "animation" | "sticker" }> = [
    { method: "sendVideo", field: "video" },
    { method: "sendAudio", field: "audio" },
    { method: "sendVoice", field: "voice" },
    { method: "sendAnimation", field: "animation" },
    { method: "sendSticker", field: "sticker" },
  ];

  for (const { method, field } of cases) {
    it(`${method} stores the media and round-trips file_id on re-send`, async () => {
      const bot = createBot(tx.store, { username: "b" });
      const user = createUser(tx.store, { first_name: "A" });
      const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

      // Seed a file so the re-send path is exercised (skip the multipart path
      // in this shape-level test).
      const ts = getTelegramStore(tx.store);
      ts.files.insert({
        file_id: `seed_${field}`,
        file_unique_id: `uq_${field}`,
        owner_bot_id: bot.bot_id,
        mime_type: "application/octet-stream",
        file_size: 1,
        width: 120,
        height: 90,
        file_path: `${field}s/${bot.bot_id}/seed_${field}`,
        bytes_base64: "",
        kind: field,
      });

      const body: { [key: string]: unknown } = { chat_id: dm.chat_id, [field]: `seed_${field}` };
      if (field !== "sticker") body.caption = "c";
      const res = await postJson(tx.app, `/bot${bot.token}/${method}`, body);
      expect(res.status).toBe(200);
      const result = (await json<{ result: { [key: string]: { file_id: string } } }>(res)).result;
      expect(result[field].file_id).toBe(`seed_${field}`);
    });
  }

  it("sticker silently strips caption (matches real Telegram)", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const ts = getTelegramStore(tx.store);
    ts.files.insert({
      file_id: "stk",
      file_unique_id: "uq_stk",
      owner_bot_id: bot.bot_id,
      mime_type: "image/webp",
      file_size: 1,
      width: 50,
      height: 50,
      file_path: `stickers/${bot.bot_id}/stk`,
      bytes_base64: "",
      kind: "sticker",
    });
    const res = await postJson(tx.app, `/bot${bot.token}/sendSticker`, {
      chat_id: dm.chat_id,
      sticker: "stk",
      caption: "nope",
    });
    expect(res.status).toBe(200);
    const body = await json<{ result: { caption?: string } }>(res);
    expect(body.result.caption).toBeUndefined();
  });

  it("simulateUserMedia produces a user message with the media field and file_id", async () => {
    const bot = createBot(tx.store, { username: "greedy", can_read_all_group_messages: true });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const result = simulateUserMedia(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      kind: "voice",
      bytes: Buffer.from("oggdata"),
      duration: 3,
    });
    expect(result.file_id).toMatch(/^tg_emu_/);

    const updates = await json<{
      result: Array<{ message: { voice?: { duration: number } } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    expect(updates.result[0].message.voice?.duration).toBe(3);
  });
});

describe("Integration — file_id preservation on photo echo", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("sendPhoto by file_id returns the same file_id in the largest tier", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQIW2P4//8/AAX+Av4zhb9VAAAAAElFTkSuQmCC",
      "base64",
    );
    const up = await json<{ file_id: string }>(
      await postJson(tx.app, `/_emu/telegram/chats/${dm.chat_id}/photos`, {
        userId: user.user_id,
        photoBase64: PNG.toString("base64"),
      }),
    );
    const echoed = await json<{ result: { photo: Array<{ file_id: string }> } }>(
      await postJson(tx.app, `/bot${bot.token}/sendPhoto`, {
        chat_id: dm.chat_id,
        photo: up.file_id,
      }),
    );
    const largest = echoed.result.photo.at(-1)!;
    expect(largest.file_id).toBe(up.file_id);
  });
});

describe("Integration — entity auto-detection", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("detects url, email, hashtag, cashtag in user text", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    simulateUserMessage(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      text: "see https://example.com or email me@x.io #urgent $AAPL",
    });

    const updates = await json<{
      result: Array<{ message: { entities: Array<{ type: string }> } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    const types = updates.result[0].message.entities.map((e) => e.type);
    expect(types).toContain("url");
    expect(types).toContain("email");
    expect(types).toContain("hashtag");
    expect(types).toContain("cashtag");
  });

  it("strips trailing punctuation from URLs", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    simulateUserMessage(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      text: "see https://example.com.",
    });
    const updates = await json<{
      result: Array<{
        message: { text: string; entities: Array<{ type: string; offset: number; length: number }> };
      }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    const url = updates.result[0].message.entities.find((e) => e.type === "url");
    const text = updates.result[0].message.text;
    const extracted = text.slice(url!.offset, url!.offset + url!.length);
    expect(extracted).toBe("https://example.com");
  });
});

describe("Integration — allowed_updates filter", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("getUpdates honours allowed_updates and skips filtered types", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "hi" });
    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "ok" }),
    );
    simulateReaction(tx.store, {
      chatId: dm.chat_id,
      messageId: sent.result.message_id,
      userId: user.user_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {
      allowed_updates: ["message_reaction"],
    });
    const body = await json<{
      result: Array<{ message_reaction?: unknown; message?: unknown }>;
    }>(res);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].message_reaction).toBeDefined();
    expect(body.result[0].message).toBeUndefined();
  });
});

describe("Integration — callback answer reader", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("GET /_emu/telegram/callbacks/:id returns the stored answer", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "pick",
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "y" }]] },
    });
    const ts = getTelegramStore(tx.store);
    const msg = ts.messages.all()[0];
    simulateCallback(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      messageId: msg.message_id,
      callbackData: "y",
    });
    const updates = await json<{ result: Array<{ callback_query?: { id: string } }> }>(
      await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}),
    );
    const id = updates.result[0].callback_query!.id;
    await postJson(tx.app, `/bot${bot.token}/answerCallbackQuery`, {
      callback_query_id: id,
      text: "Yes!",
      show_alert: true,
    });

    const answer = getCallbackAnswer(tx.store, id);
    expect(answer?.answered).toBe(true);
    expect(answer?.answer_text).toBe("Yes!");
    expect(answer?.answer_show_alert).toBe(true);

    const httpAnswer = await tx.app.request(`http://localhost:4011/_emu/telegram/callbacks/${id}`);
    expect(httpAnswer.status).toBe(200);
    const httpBody = (await httpAnswer.json()) as {
      ok: true;
      callback_query_id: string;
      answered: boolean;
      answer_text: string;
      answer_show_alert?: boolean;
    };
    expect(httpBody.answer_text).toBe("Yes!");
  });
});

describe("Integration — parse_mode", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("MarkdownV2 round-trips formatted message into entities", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "*hello* [x](https://a.io)",
      parse_mode: "MarkdownV2",
    });
    const body = await json<{ ok: boolean; result: { text: string; entities: unknown[] } }>(res);
    expect(body.ok).toBe(true);
    expect(body.result.text).toBe("hello x");
    expect(body.result.entities).toEqual([
      { type: "bold", offset: 0, length: 5 },
      { type: "text_link", offset: 6, length: 1, url: "https://a.io" },
    ]);
  });

  it("MarkdownV2 returns 400 with Telegram-shaped error on unescaped reserved char", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "hello.",
      parse_mode: "MarkdownV2",
    });
    expect(res.status).toBe(400);
    const body = await json<{ ok: boolean; description: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.description).toContain("can't parse entities");
    expect(body.description).toContain(".");
  });

  it("HTML parse_mode works for sendMessage", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: '<b>hello</b> <a href="https://a.io">x</a>',
      parse_mode: "HTML",
    });
    const body = await json<{ result: { text: string; entities: unknown[] } }>(res);
    expect(body.result.text).toBe("hello x");
    expect(body.result.entities).toEqual([
      { type: "bold", offset: 0, length: 5 },
      { type: "text_link", offset: 6, length: 1, url: "https://a.io" },
    ]);
  });

  it("parse_mode applies to sendPhoto.caption and sendDocument.caption", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    // Seed a doc
    getTelegramStore(tx.store).files.insert({
      file_id: "doc_1",
      file_unique_id: "uq_doc_1",
      owner_bot_id: bot.bot_id,
      mime_type: "application/pdf",
      file_size: 1,
      width: 0,
      height: 0,
      file_path: `documents/${bot.bot_id}/doc_1`,
      bytes_base64: "",
      kind: "document",
    });

    const res = await postJson(tx.app, `/bot${bot.token}/sendDocument`, {
      chat_id: dm.chat_id,
      document: "doc_1",
      caption: "*heading*",
      parse_mode: "MarkdownV2",
    });
    const body = await json<{ result: { caption: string; caption_entities: unknown[] } }>(res);
    expect(body.result.caption).toBe("heading");
    expect(body.result.caption_entities).toEqual([{ type: "bold", offset: 0, length: 7 }]);
  });

  it("editMessageText applies parse_mode", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "v1" }),
    );
    const edited = await json<{ result: { text: string; entities: unknown[] } }>(
      await postJson(tx.app, `/bot${bot.token}/editMessageText`, {
        chat_id: dm.chat_id,
        message_id: sent.result.message_id,
        text: "~v2~",
        parse_mode: "MarkdownV2",
      }),
    );
    expect(edited.result.text).toBe("v2");
    expect(edited.result.entities).toEqual([{ type: "strikethrough", offset: 0, length: 2 }]);
  });
});

describe("Integration — small methods", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("sendChatAction returns true for any action", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const res = await postJson(tx.app, `/bot${bot.token}/sendChatAction`, {
      chat_id: 1,
      action: "typing",
    });
    const body = await json<{ ok: boolean; result: boolean }>(res);
    expect(body.ok).toBe(true);
    expect(body.result).toBe(true);
  });

  it("getChatMember reports creator / administrator / member", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const alice = createUser(tx.store, { first_name: "A" });
    const bob = createUser(tx.store, { first_name: "B" });
    const carol = createUser(tx.store, { first_name: "C" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [alice.user_id, bob.user_id, carol.user_id],
      botIds: [bot.bot_id],
      creatorUserId: alice.user_id,
      adminUserIds: [bob.user_id],
    });

    const call = async (uid: number) =>
      json<{ result: { status: string; can_manage_chat?: boolean } }>(
        await postJson(tx.app, `/bot${bot.token}/getChatMember`, { chat_id: group.chat_id, user_id: uid }),
      );

    expect((await call(alice.user_id)).result.status).toBe("creator");
    expect((await call(bob.user_id)).result.status).toBe("administrator");
    expect((await call(carol.user_id)).result.status).toBe("member");
    expect((await call(alice.user_id)).result.can_manage_chat).toBe(true);
  });

  it("getChatAdministrators returns creator + admins", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const alice = createUser(tx.store, { first_name: "A" });
    const bob = createUser(tx.store, { first_name: "B" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [alice.user_id, bob.user_id],
      botIds: [bot.bot_id],
      creatorUserId: alice.user_id,
      adminUserIds: [bob.user_id],
    });
    const body = await json<{ result: Array<{ status: string; user: { id: number } }> }>(
      await postJson(tx.app, `/bot${bot.token}/getChatAdministrators`, { chat_id: group.chat_id }),
    );
    expect(body.result).toHaveLength(2);
    expect(body.result[0].status).toBe("creator");
    expect(body.result[0].user.id).toBe(alice.user_id);
    expect(body.result[1].status).toBe("administrator");
    expect(body.result[1].user.id).toBe(bob.user_id);
  });

  it("getChat returns ChatFullInfo shape with permissions + accent_color_id", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const u1 = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [u1.user_id],
      botIds: [bot.bot_id],
    });
    const body = await json<{
      ok: boolean;
      result: {
        id: number;
        type: string;
        title: string;
        accent_color_id: number;
        max_reaction_count: number;
        permissions: { can_send_messages: boolean };
      };
    }>(await postJson(tx.app, `/bot${bot.token}/getChat`, { chat_id: group.chat_id }));
    expect(body.result.type).toBe("group");
    expect(body.result.title).toBe("G");
    expect(body.result.accent_color_id).toBe(0);
    expect(body.result.max_reaction_count).toBe(11);
    expect(body.result.permissions.can_send_messages).toBe(true);
  });

  it("getChatMemberCount returns member + bot count", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const u1 = createUser(tx.store, { first_name: "A" });
    const u2 = createUser(tx.store, { first_name: "B" });
    const group = createGroupChat(tx.store, {
      title: "g",
      memberIds: [u1.user_id, u2.user_id],
      botIds: [bot.bot_id],
    });
    const body = await json<{ ok: boolean; result: number }>(
      await postJson(tx.app, `/bot${bot.token}/getChatMemberCount`, { chat_id: group.chat_id }),
    );
    expect(body.result).toBe(3);
  });
});

describe("Integration — reply_to_message full object", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("bot reply with reply_to_message_id populates a reply_to_message object", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const first = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "parent" }),
    );

    const reply = await json<{
      result: { reply_to_message_id: number; reply_to_message: { text: string } };
    }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
        chat_id: dm.chat_id,
        text: "child",
        reply_to_message_id: first.result.message_id,
      }),
    );
    expect(reply.result.reply_to_message_id).toBe(first.result.message_id);
    expect(reply.result.reply_to_message.text).toBe("parent");
  });
});

describe("Integration — reactions", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("setMessageReaction stores the bot's reaction and is observable via store", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "ok" }),
    );

    const res = await postJson(tx.app, `/bot${bot.token}/setMessageReaction`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(res.status).toBe(200);
    const stored = getTelegramStore(tx.store).reactions.all();
    expect(stored).toHaveLength(1);
    expect(stored[0].reaction[0]).toEqual({ type: "emoji", emoji: "👍" });
    expect(stored[0].sender_bot_id).toBe(bot.bot_id);
  });

  it("setMessageReaction with empty array clears the reaction", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "ok" }),
    );

    await postJson(tx.app, `/bot${bot.token}/setMessageReaction`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    await postJson(tx.app, `/bot${bot.token}/setMessageReaction`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      reaction: [],
    });
    expect(getTelegramStore(tx.store).reactions.all()).toHaveLength(0);
  });

  it("bot editMessageText dispatches edited_message to other bots in the chat", async () => {
    const botA = createBot(tx.store, { username: "ba", can_read_all_group_messages: true });
    const botB = createBot(tx.store, { username: "bb", can_read_all_group_messages: true });
    const user = createUser(tx.store, { first_name: "U" });
    const group = createGroupChat(tx.store, {
      title: "G",
      memberIds: [user.user_id],
      botIds: [botA.bot_id, botB.bot_id],
    });

    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${botA.token}/sendMessage`, { chat_id: group.chat_id, text: "hi" }),
    );
    // Drain any existing updates for botB first.
    await postJson(tx.app, `/bot${botB.token}/getUpdates`, {});

    await postJson(tx.app, `/bot${botA.token}/editMessageText`, {
      chat_id: group.chat_id,
      message_id: sent.result.message_id,
      text: "hi (edited)",
    });

    const updates = await json<{ result: Array<{ edited_message?: { text: string } }> }>(
      await postJson(tx.app, `/bot${botB.token}/getUpdates`, {}),
    );
    expect(updates.result.some((u) => u.edited_message?.text === "hi (edited)")).toBe(true);
  });

  it("simulateReaction dispatches message_reaction Update to bots in chat", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const sent = await json<{ result: { message_id: number } }>(
      await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "ok" }),
    );

    simulateReaction(tx.store, {
      chatId: dm.chat_id,
      messageId: sent.result.message_id,
      userId: user.user_id,
      reaction: [{ type: "emoji", emoji: "❤️" }],
    });

    const updates = await json<{
      result: Array<{
        message_reaction?: { new_reaction: Array<{ emoji: string }> };
        message_reaction_count?: { reactions: Array<{ type: unknown; total_count: number }> };
      }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    // One message_reaction (per-user) + one message_reaction_count (anonymous
    // aggregate) — matches real Telegram's dispatch shape.
    expect(updates.result).toHaveLength(2);
    const reaction = updates.result.find((u) => u.message_reaction);
    const count = updates.result.find((u) => u.message_reaction_count);
    expect(reaction?.message_reaction?.new_reaction[0].emoji).toBe("❤️");
    expect(count?.message_reaction_count?.reactions).toHaveLength(1);
    expect(count?.message_reaction_count?.reactions[0].total_count).toBe(1);
  });
});

describe("Integration — answerCallbackQuery stores the answer", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("answerCallbackQuery persists text + show_alert on the callback row", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    // Bot sends a keyboard
    await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "pick",
      reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] },
    });

    // User taps
    const ts = getTelegramStore(tx.store);
    const sent = ts.messages.all()[0];
    simulateCallback(tx.store, {
      chatId: dm.chat_id,
      userId: user.user_id,
      messageId: sent.message_id,
      callbackData: "a",
    });

    // Bot answers with text + alert
    const updates = await json<{
      result: Array<{ callback_query?: { id: string } }>;
    }>(await postJson(tx.app, `/bot${bot.token}/getUpdates`, {}));
    const id = updates.result[0].callback_query!.id;
    await postJson(tx.app, `/bot${bot.token}/answerCallbackQuery`, {
      callback_query_id: id,
      text: "Confirmed",
      show_alert: true,
    });

    const row = ts.callbackQueries.findOneBy("callback_query_id", id);
    expect(row?.answered).toBe(true);
    expect(row?.answer_text).toBe("Confirmed");
    expect(row?.answer_show_alert).toBe(true);
  });
});
