import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { generateTs, slackOk, slackError, parseSlackBody } from "../helpers.js";

export function chatRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);

  // chat.postMessage
  app.post("/api/chat.postMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";
    const thread_ts = typeof body.thread_ts === "string" ? body.thread_ts : undefined;

    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel)
      ?? ss().channels.findOneBy("name", channel);
    if (!ch) return slackError(c, "channel_not_found");

    const ts = generateTs();
    const msg = ss().messages.insert({
      ts,
      channel_id: ch.channel_id,
      user: authUser.login,
      text,
      type: "message" as const,
      thread_ts,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    // Update parent thread reply count
    if (thread_ts) {
      const parent = ss().messages.all().find((m) => m.ts === thread_ts && m.channel_id === ch.channel_id);
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

    await webhooks.dispatch("message", {
      type: "event_callback",
      event: {
        type: "message",
        channel: ch.channel_id,
        user: authUser.login,
        text,
        ts,
        thread_ts,
      },
    });

    return slackOk(c, {
      channel: ch.channel_id,
      ts,
      message: {
        text: msg.text,
        user: msg.user,
        type: msg.type,
        ts: msg.ts,
        thread_ts: msg.thread_ts,
      },
    });
  });

  // chat.update
  app.post("/api/chat.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (!channel || !ts) return slackError(c, "message_not_found");

    const msg = ss().messages.all().find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    ss().messages.update(msg.id, { text });

    return slackOk(c, {
      channel,
      ts,
      text,
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

    const msg = ss().messages.all().find((m) => m.ts === ts && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    ss().messages.delete(msg.id);

    return slackOk(c, { channel, ts });
  });

  // chat.meMessage
  app.post("/api/chat.meMessage", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const text = typeof body.text === "string" ? body.text : "";

    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel)
      ?? ss().channels.findOneBy("name", channel);
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
