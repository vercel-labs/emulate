import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, postJson, json, type TestApp } from "./helpers.js";
import { getTelegramStore } from "../store.js";
import { getDispatcher } from "../dispatcher.js";
import { createBot, createPrivateChat, createUser, simulateUserMessage } from "../routes/control.js";
import type { WireUpdate } from "../types/wire/index.js";

describe("Telegram webhook delivery", () => {
  let tx: TestApp;

  beforeEach(() => {
    tx = createTestApp({ seed: false });
  });

  it("POSTs Update JSON to the configured webhook URL on user activity", async () => {
    const received: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    getDispatcher(tx.store).setFetchImpl(async (url, init) => {
      const headers: Record<string, string> = {};
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
      received.push({
        url: typeof url === "string" ? url : url.toString(),
        headers,
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(null, { status: 200 });
    });

    const bot = createBot(tx.store, { username: "trip_bot" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });

    await postJson(tx.app, `/bot${bot.token}/setWebhook`, {
      url: "https://example.com/webhook",
      secret_token: "sekret",
    });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "hello" });

    // Dispatcher is async; yield the event loop a few times.
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("https://example.com/webhook");
    expect(received[0].headers["x-telegram-bot-api-secret-token"]).toBe("sekret");
    const body = received[0].body as WireUpdate;
    expect(body.update_id).toBe(1);
    if (!("message" in body)) throw new Error("expected message update");
    expect(body.message.text).toBe("hello");
  });

  it("retries on 5xx up to maxRetries, succeeds on eventual 200", async () => {
    let attempts = 0;
    getDispatcher(tx.store).setRetryPolicy({ maxRetries: 2, backoffMs: [1, 1] });
    getDispatcher(tx.store).setBackoffEnabled(false);
    getDispatcher(tx.store).setFetchImpl(async () => {
      attempts += 1;
      if (attempts < 3) return new Response(null, { status: 502 });
      return new Response(null, { status: 200 });
    });

    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    await postJson(tx.app, `/bot${bot.token}/setWebhook`, { url: "https://example.com/webhook" });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "retry-me" });
    await new Promise((r) => setTimeout(r, 20));

    expect(attempts).toBe(3);
    const updates = getTelegramStore(tx.store).updates.all();
    expect(updates).toHaveLength(1);
    expect(updates[0].delivered).toBe(true);
    expect(updates[0].delivery_attempts).toBe(3);
  });

  it("stops retrying on 4xx terminal error", async () => {
    let attempts = 0;
    getDispatcher(tx.store).setFetchImpl(async () => {
      attempts += 1;
      return new Response(null, { status: 403 });
    });

    const bot = createBot(tx.store, { username: "b" });
    const user = createUser(tx.store, { first_name: "A" });
    const dm = createPrivateChat(tx.store, { botId: bot.bot_id, userId: user.user_id });
    await postJson(tx.app, `/bot${bot.token}/setWebhook`, { url: "https://example.com/webhook" });

    simulateUserMessage(tx.store, { chatId: dm.chat_id, userId: user.user_id, text: "nope" });
    await new Promise((r) => setTimeout(r, 20));

    expect(attempts).toBe(1);
    const updates = getTelegramStore(tx.store).updates.all();
    expect(updates[0].delivered).toBe(false);
    expect(updates[0].delivery_error).toContain("403");
  });

  it("deleteWebhook reverts bot to long-polling mode", async () => {
    const bot = createBot(tx.store, { username: "b" });
    await postJson(tx.app, `/bot${bot.token}/setWebhook`, { url: "https://example.com/webhook" });
    await postJson(tx.app, `/bot${bot.token}/deleteWebhook`, {});

    // Now getUpdates should work (not 409)
    const res = await postJson(tx.app, `/bot${bot.token}/getUpdates`, {});
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });
});
