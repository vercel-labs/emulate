import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { generateTs } from "../helpers.js";

export function webhookRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);

  // Incoming Webhooks - POST /services/:teamId/:botId/:token
  // The simplest Slack integration: apps POST JSON to send a message to a channel.
  app.post("/services/:teamId/:botId/:token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const rawText = await c.req.text();

    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(rawText);
      } catch {
        return c.text("invalid_payload", 400);
      }
    } else {
      // Slack also accepts form-urlencoded with a "payload" field
      const params = new URLSearchParams(rawText);
      const payload = params.get("payload");
      if (payload) {
        try {
          body = JSON.parse(payload);
        } catch {
          return c.text("invalid_payload", 400);
        }
      } else {
        body = {};
      }
    }

    const text = typeof body.text === "string" ? body.text : "";
    const channelName = typeof body.channel === "string" ? body.channel : "";
    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : undefined;

    if (!text && !body.blocks && !body.attachments) {
      return c.text("no_text", 400);
    }

    // Find target channel: explicit channel, webhook default, or #general
    const webhook = ss().incomingWebhooks.all().find(
      (w) => w.token === c.req.param("token")
    );

    let targetChannel = channelName
      ? (ss().channels.findOneBy("name", channelName) ?? ss().channels.findOneBy("channel_id", channelName))
      : null;

    if (!targetChannel && webhook) {
      targetChannel = ss().channels.findOneBy("name", webhook.default_channel)
        ?? ss().channels.findOneBy("channel_id", webhook.default_channel);
    }

    if (!targetChannel) {
      targetChannel = ss().channels.findOneBy("name", "general");
    }

    if (!targetChannel) {
      return c.text("channel_not_found", 404);
    }

    const ts = generateTs();
    const botId = c.req.param("botId");

    ss().messages.insert({
      ts,
      channel_id: targetChannel.channel_id,
      user: botId,
      text: text || "(rich message)",
      type: "message" as const,
      subtype: "bot_message",
      thread_ts: threadTs,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    await webhooks.dispatch("message", {
      type: "event_callback",
      event: {
        type: "message",
        subtype: "bot_message",
        channel: targetChannel.channel_id,
        bot_id: botId,
        text: text || "(rich message)",
        ts,
        thread_ts: threadTs,
      },
    });

    return c.text("ok");
  });
}
