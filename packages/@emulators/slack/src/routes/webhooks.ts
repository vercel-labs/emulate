import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import {
  applySlackTextLimit,
  formatSlackMessage,
  generateTs,
  hasSlackMessageContent,
  parseSlackRichMessageFields,
  validateSlackRichMessageLimits,
} from "../helpers.js";

export function webhookRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const findChannel = (channel: string) =>
    ss().channels.findOneBy("channel_id", channel) ??
    ss()
      .channels.all()
      .find((ch) => !ch.is_im && !ch.is_mpim && ch.name === channel);

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

    const textLimit = applySlackTextLimit(typeof body.text === "string" ? body.text : "");
    const text = textLimit.text;
    const channelName = typeof body.channel === "string" ? body.channel : "";
    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) {
      return c.text(richMessage.error, 400);
    }
    const limitError = validateSlackRichMessageLimits(richMessage.fields);
    if (limitError) {
      return c.text(limitError, 400);
    }

    if (!hasSlackMessageContent(text, richMessage.fields)) {
      return c.text("no_text", 400);
    }

    // Find target channel: explicit channel, webhook default, or #general
    const webhook = ss()
      .incomingWebhooks.all()
      .find((w) => w.token === c.req.param("token"));

    let targetChannel = channelName ? findChannel(channelName) : null;

    if (!targetChannel && webhook) {
      targetChannel = findChannel(webhook.default_channel);
    }

    if (!targetChannel) {
      targetChannel = findChannel("general");
    }

    if (!targetChannel) {
      return c.text("channel_not_found", 404);
    }

    const ts = generateTs();
    const botId = c.req.param("botId");

    const msg = ss().messages.insert({
      ts,
      channel_id: targetChannel.channel_id,
      user: botId,
      text,
      type: "message" as const,
      subtype: "bot_message",
      thread_ts: threadTs,
      ...richMessage.fields,
      bot_id: botId,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    const { user: _user, ...eventMessage } = formatSlackMessage(msg);

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          ...eventMessage,
          type: "message",
          subtype: "bot_message",
          channel: targetChannel.channel_id,
          bot_id: botId,
        },
      },
      "slack",
    );

    return c.text("ok");
  });
}
