import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, postJson, json, type TestApp } from "./helpers.js";
import { getTelegramStore } from "../store.js";
import {
  addBotToChat,
  createBot,
  createGroupChat,
  createPrivateChat,
  createUser,
  getDraftHistory,
  removeBotFromChat,
  simulateUserMessage,
} from "../routes/control.js";

describe("sendMessageDraft", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("appends draft snapshots under stable draft_id", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const chunks = ["Sure", "Sure, let me ", "Sure, let me check", "Sure, let me check. Done."];
    for (const text of chunks) {
      const res = await postJson(tx.app, `/bot${bot.token}/sendMessageDraft`, {
        chat_id: dm.chat_id,
        draft_id: 42,
        text,
      });
      expect(res.status).toBe(200);
      const body = await json<{ ok: boolean; result: boolean }>(res);
      expect(body.ok).toBe(true);
      expect(body.result).toBe(true);
    }

    const history = getDraftHistory(tx.store, { chatId: dm.chat_id, draftId: 42 });
    expect(history).toHaveLength(4);
    expect(history.map((s) => s.text)).toEqual(chunks);
    expect(history.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  it("does not insert a Message row (drafts are off-history)", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    await postJson(tx.app, `/bot${bot.token}/sendMessageDraft`, {
      chat_id: dm.chat_id,
      draft_id: 1,
      text: "stream chunk",
    });

    const messagesInChat = getTelegramStore(tx.store).messages.findBy("chat_id", dm.chat_id);
    expect(messagesInChat).toHaveLength(0);
  });

  it("rejects draft in a group chat (private chats only, per Bot API 9.5)", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, { title: "g", memberIds: [user.user_id], botIds: [bot.bot_id] });

    const res = await postJson(tx.app, `/bot${bot.token}/sendMessageDraft`, {
      chat_id: group.chat_id,
      draft_id: 1,
      text: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("rejects draft_id = 0", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    const res = await postJson(tx.app, `/bot${bot.token}/sendMessageDraft`, {
      chat_id: dm.chat_id,
      draft_id: 0,
      text: "x",
    });
    expect(res.status).toBe(400);
  });
});

describe("editMessageText", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("edits a bot-sent message and sets edit_date", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const sendRes = await postJson(tx.app, `/bot${bot.token}/sendMessage`, {
      chat_id: dm.chat_id,
      text: "v1",
    });
    const sent = await json<{ result: { message_id: number } }>(sendRes);

    const editRes = await postJson(tx.app, `/bot${bot.token}/editMessageText`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      text: "v2",
    });
    const edited = await json<{ ok: boolean; result: { text: string; edit_date: number } }>(editRes);
    expect(edited.ok).toBe(true);
    expect(edited.result.text).toBe("v2");
    expect(edited.result.edit_date).toBeGreaterThan(0);
  });

  it("rejects editing a message sent by another bot", async () => {
    const a = createBot(tx.store, { username: "a" });
    const b = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: a.bot_id, userId: user.user_id });
    // a is only bot — add b to the chat so we can exercise rejection
    const ts = getTelegramStore(tx.store);
    ts.chats.update(ts.chats.findOneBy("chat_id", dm.chat_id)!.id, {
      member_bot_ids: [a.bot_id, b.bot_id],
    });

    const sendRes = await postJson(tx.app, `/bot${a.token}/sendMessage`, { chat_id: dm.chat_id, text: "mine" });
    const sent = await json<{ result: { message_id: number } }>(sendRes);

    const editRes = await postJson(tx.app, `/bot${b.token}/editMessageText`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
      text: "hijack",
    });
    expect(editRes.status).toBe(403);
  });
});

describe("deleteMessage", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("soft-deletes the message; getAllMessages hides it", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    const sendRes = await postJson(tx.app, `/bot${bot.token}/sendMessage`, { chat_id: dm.chat_id, text: "to be deleted" });
    const sent = await json<{ result: { message_id: number } }>(sendRes);

    const delRes = await postJson(tx.app, `/bot${bot.token}/deleteMessage`, {
      chat_id: dm.chat_id,
      message_id: sent.result.message_id,
    });
    const delBody = await json<{ ok: boolean; result: boolean }>(delRes);
    expect(delBody.ok).toBe(true);
    expect(delBody.result).toBe(true);

    const all = await json<{ messages: unknown[] }>(
      await tx.app.request(`http://localhost:4011/_emu/telegram/chats/${dm.chat_id}/messages?scope=all`),
    );
    expect(all.messages).toHaveLength(0);

    const storeRow = getTelegramStore(tx.store)
      .messages.findBy("chat_id", dm.chat_id)
      .find((m) => m.message_id === sent.result.message_id);
    expect(storeRow?.deleted).toBe(true);
  });
});

describe("sendDocument", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("accepts file_id and echoes it back in message.document", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    // Upload a doc directly via the files collection to mimic a prior upload
    const ts = getTelegramStore(tx.store);
    ts.files.insert({
      file_id: "seed_doc_1",
      file_unique_id: "uq_seed_doc_1",
      owner_bot_id: bot.bot_id,
      mime_type: "application/pdf",
      file_size: 1024,
      width: 0,
      height: 0,
      file_path: `documents/${bot.bot_id}/seed_doc_1`,
      bytes_base64: Buffer.from("pdfdata").toString("base64"),
      kind: "document",
      file_name: "trip.pdf",
    });

    const res = await postJson(tx.app, `/bot${bot.token}/sendDocument`, {
      chat_id: dm.chat_id,
      document: "seed_doc_1",
      caption: "your itinerary",
    });
    const body = await json<{ ok: boolean; result: { document: { file_id: string; file_name?: string; mime_type?: string } } }>(res);
    expect(body.ok).toBe(true);
    expect(body.result.document.file_name).toBe("trip.pdf");
    expect(body.result.document.mime_type).toBe("application/pdf");
    // file_id preserved on re-send (matches real Telegram behaviour).
    expect(body.result.document.file_id).toBe("seed_doc_1");

    // Download the file_id via HTTP — reuses the original file path.
    const dl = await tx.app.request(
      `http://localhost:4011/file/bot${bot.token}/documents/${bot.bot_id}/${body.result.document.file_id}`,
    );
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("pdfdata");
  });
});

describe("my_chat_member Update", () => {
  let tx: TestApp;
  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("dispatches my_chat_member when bot is added to a group", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, { title: "g", memberIds: [user.user_id], botIds: [] });

    addBotToChat(tx.store, { chatId: group.chat_id, botId: bot.bot_id, byUserId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    const body = await json<{
      result: Array<{ my_chat_member?: { new_chat_member: { status: string } } }>;
    }>(res);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].my_chat_member?.new_chat_member.status).toBe("member");
  });

  it("dispatches my_chat_member when bot is removed from a group", async () => {
    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "g",
      memberIds: [user.user_id],
      botIds: [bot.bot_id],
    });

    // Drain the prior state — no updates yet
    removeBotFromChat(tx.store, { chatId: group.chat_id, botId: bot.bot_id, byUserId: user.user_id });

    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    const body = await json<{
      result: Array<{ my_chat_member?: { new_chat_member: { status: string }; old_chat_member: { status: string } } }>;
    }>(res);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].my_chat_member?.old_chat_member.status).toBe("member");
    expect(body.result[0].my_chat_member?.new_chat_member.status).toBe("left");
  });

  it("removed bot no longer sees new group messages", async () => {
    const bot = createBot(tx.store, { username: "greedy", can_read_all_group_messages: true });
    const user = createUser(tx.store, { first_name: "A" });
    const group = createGroupChat(tx.store, {
      title: "g",
      memberIds: [user.user_id],
      botIds: [bot.bot_id],
    });

    removeBotFromChat(tx.store, { chatId: group.chat_id, botId: bot.bot_id, byUserId: user.user_id });
    // Drain the my_chat_member update
    await postJson(tx.app, `/bot${bot.token}/getUpdates`, { offset: 2 });

    // Now a user sends a regular message in the group — bot should not get it
    simulateUserMessage(tx.store, {
      chatId: group.chat_id,
      userId: user.user_id,
      text: "hello group",
    });
    // But simulateUserMessage only dispatches to bots in member_bot_ids — which no longer includes us
    const after = await postJson(tx.app, `/bot${bot.token}/getUpdates`, { offset: 2 });
    const body = await json<{ result: unknown[] }>(after);
    expect(body.result).toHaveLength(0);
  });
});
