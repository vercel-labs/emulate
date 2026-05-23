import type { Context, RouteContext } from "@emulators/core";
import type { SlackChannel, SlackMessage, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackMessage,
  formatSlackPermalink,
  formatSlackScheduledMessage,
  formatSlackScheduledMessageListItem,
  generateSlackId,
  generateTs,
  hasSlackMessageContent,
  parseSlackBody,
  parseSlackRichMessageFields,
  slackError,
  slackOk,
} from "../helpers.js";

export function chatRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, baseUrl } = ctx;
  const ss = () => getSlackStore(store);
  const findChannel = (channel: string) =>
    ss().channels.findOneBy("channel_id", channel) ?? ss().channels.findOneBy("name", channel);
  const isChannelMember = (channel: SlackChannel, user: SlackUser) =>
    channel.members.includes(user.user_id) || channel.members.includes(user.name);

  // chat.postMessage
  app.post("/api/chat.postMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";
    const thread_ts = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel) return slackError(c, "channel_not_found");
    if (!hasSlackMessageContent(text, richMessage.fields)) return slackError(c, "no_text");

    const ch = ss().channels.findOneBy("channel_id", channel) ?? ss().channels.findOneBy("name", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const ts = generateTs();
    const msg = ss().messages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "message" as const,
      thread_ts,
      ...richMessage.fields,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    // Update parent thread reply count
    if (thread_ts) {
      const parent = ss()
        .messages.all()
        .find((m) => m.ts === thread_ts && m.channel_id === ch.channel_id);
      if (parent) {
        const replyUsers = parent.reply_users.includes(authUser.login)
          ? parent.reply_users
          : [...parent.reply_users, authUser.login];
        ss().messages.update(parent.id, {
          reply_count: parent.reply_count + 1,
          reply_users: replyUsers,
        });
      }
    }

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          ...formatSlackMessage(msg),
          type: "message",
          channel: ch.channel_id,
        },
      },
      "slack",
    );

    return slackOk(c, {
      channel: ch.channel_id,
      ts,
      message: formatSlackMessage(msg),
    });
  });

  // chat.postEphemeral
  app.post("/api/chat.postEphemeral", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const user = typeof body.user === "string" ? body.user : "";
    const text = typeof body.text === "string" ? body.text : "";
    const thread_ts = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel) return slackError(c, "channel_not_found");
    if (!user) return slackError(c, "user_not_found");
    if (!hasSlackMessageContent(text, richMessage.fields)) return slackError(c, "no_text");

    const ch = findChannel(channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const targetUser = ss().users.findOneBy("user_id", user);
    if (!targetUser) return slackError(c, "user_not_found");
    if (!isChannelMember(ch, targetUser)) return slackError(c, "user_not_in_channel");

    const ts = generateTs();
    ss().ephemeralMessages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      target_user: targetUser.user_id,
      text,
      type: "message" as const,
      thread_ts,
      ...richMessage.fields,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    return slackOk(c, { message_ts: ts });
  });

  // chat.update
  app.post("/api/chat.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";
    const hasText = typeof body.text === "string";
    const text = hasText ? (body.text as string) : "";
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel || !ts) return slackError(c, "message_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const updates: Partial<SlackMessage> = { ...richMessage.fields };
    if (hasText) {
      updates.text = text;
      if (!richMessage.providedFields.includes("blocks")) updates.blocks = undefined;
      if (!richMessage.providedFields.includes("attachments")) updates.attachments = undefined;
    }

    if (!hasText && Object.keys(updates).length === 0) {
      return slackError(c, "no_text");
    }

    const eventTs = generateTs();
    const updated = ss().messages.update(msg.id, {
      ...updates,
      edited: { user: authUser.login, ts: eventTs },
    })!;

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "message_changed",
          hidden: true,
          channel,
          ts: eventTs,
          event_ts: eventTs,
          message: formatSlackMessage(updated),
          previous_message: formatSlackMessage(msg),
        },
      },
      "slack",
    );

    return slackOk(c, {
      channel,
      ts,
      text: updated.text,
      message: formatSlackMessage(updated),
    });
  });

  // chat.delete
  app.post("/api/chat.delete", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";

    if (!channel || !ts) return slackError(c, "message_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    ss().messages.delete(msg.id);

    const eventTs = generateTs();
    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "message",
          subtype: "message_deleted",
          hidden: true,
          channel,
          ts: eventTs,
          event_ts: eventTs,
          deleted_ts: ts,
          previous_message: formatSlackMessage(msg),
        },
      },
      "slack",
    );

    return slackOk(c, { channel, ts });
  });

  async function getPermalink(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = c.req.method === "GET" ? {} : await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : (c.req.query("channel") ?? "");
    const messageTs = typeof body.message_ts === "string" ? body.message_ts : (c.req.query("message_ts") ?? "");

    if (!channel) return slackError(c, "channel_not_found");
    if (!messageTs) return slackError(c, "message_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === messageTs && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    return slackOk(c, {
      channel,
      permalink: formatSlackPermalink(baseUrl, ch.channel_id, msg),
    });
  }

  // chat.getPermalink
  app.get("/api/chat.getPermalink", getPermalink);
  app.post("/api/chat.getPermalink", getPermalink);

  // chat.scheduleMessage
  app.post("/api/chat.scheduleMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";
    const postAt = Number(body.post_at);
    const thread_ts = typeof body.thread_ts === "string" ? body.thread_ts : undefined;
    const richMessage = parseSlackRichMessageFields(body);
    if (richMessage.error) return slackError(c, richMessage.error);

    if (!channel) return slackError(c, "channel_not_found");
    if (!hasSlackMessageContent(text, richMessage.fields)) return slackError(c, "no_text");
    if (!Number.isFinite(postAt) || postAt <= 0) return slackError(c, "invalid_time");

    const now = Math.floor(Date.now() / 1000);
    const postAtSeconds = Math.floor(postAt);
    if (postAtSeconds <= now) return slackError(c, "time_in_past");
    if (postAtSeconds > now + 120 * 24 * 60 * 60) return slackError(c, "time_too_far");

    const ch = findChannel(channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const scheduled = ss().scheduledMessages.insert({
      scheduled_message_id: generateSlackId("Q"),
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "delayed_message" as const,
      subtype: "bot_message" as const,
      thread_ts,
      ...richMessage.fields,
      post_at: postAtSeconds,
      date_created: now,
    });

    return slackOk(c, {
      channel: ch.channel_id,
      scheduled_message_id: scheduled.scheduled_message_id,
      post_at: String(scheduled.post_at),
      message: formatSlackScheduledMessage(scheduled),
    });
  });

  // chat.deleteScheduledMessage
  app.post("/api/chat.deleteScheduledMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const scheduledMessageId = typeof body.scheduled_message_id === "string" ? body.scheduled_message_id : "";

    if (!channel) return slackError(c, "channel_not_found");
    if (!scheduledMessageId) return slackError(c, "invalid_scheduled_message_id");

    const ch = findChannel(channel);
    if (!ch) return slackError(c, "channel_not_found");

    const scheduled = ss()
      .scheduledMessages.all()
      .find((m) => m.channel_id === ch.channel_id && m.scheduled_message_id === scheduledMessageId);
    if (!scheduled) return slackError(c, "invalid_scheduled_message_id");

    ss().scheduledMessages.delete(scheduled.id);
    return slackOk(c, {});
  });

  // chat.scheduledMessages.list
  app.post("/api/chat.scheduledMessages.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const cursor = typeof body.cursor === "string" ? body.cursor : "";
    const requestedLimit = body.limit === undefined ? 100 : Number(body.limit);
    const oldest = body.oldest === undefined ? undefined : Number(body.oldest);
    const latest = body.latest === undefined ? undefined : Number(body.latest);

    if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
      return slackError(c, "invalid_arguments");
    }
    if (oldest !== undefined && latest !== undefined && oldest > latest) {
      return slackError(c, "invalid_arguments");
    }
    const limit = Math.min(Math.floor(requestedLimit), 1000);

    const ch = channel ? findChannel(channel) : undefined;
    if (channel && !ch) return slackError(c, "channel_not_found");

    const allScheduled = ss()
      .scheduledMessages.all()
      .filter((msg) => !ch || msg.channel_id === ch.channel_id)
      .filter((msg) => oldest === undefined || msg.post_at >= oldest)
      .filter((msg) => latest === undefined || msg.post_at <= latest)
      .sort((a, b) => a.post_at - b.post_at || a.scheduled_message_id.localeCompare(b.scheduled_message_id));

    let startIndex = 0;
    if (cursor) {
      const idx = allScheduled.findIndex((msg) => msg.scheduled_message_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allScheduled.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < allScheduled.length ? allScheduled[startIndex + limit].scheduled_message_id : "";

    return slackOk(c, {
      scheduled_messages: page.map(formatSlackScheduledMessageListItem),
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // chat.meMessage
  app.post("/api/chat.meMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel) ?? ss().channels.findOneBy("name", channel);
    if (!ch) return slackError(c, "channel_not_found");

    const ts = generateTs();
    ss().messages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "message" as const,
      subtype: "me_message",
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    return slackOk(c, { channel: ch.channel_id, ts });
  });
}
