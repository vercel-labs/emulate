import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import {
  bodyBoolean,
  bodyString,
  bodyStringArray,
  discordError,
  discordNoContent,
  formatMessage,
  generateSnowflake,
  getAuthedUser,
  parseJsonBody,
  requireDiscordAuth,
} from "../helpers.js";

export function messageRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.use("/api/v10/channels/:channelId/messages/*", requireDiscordAuth(ctx));
  app.use("/api/v10/channels/:channelId/messages", requireDiscordAuth(ctx));

  app.get("/api/v10/channels/:channelId/messages", (c) => {
    const channel = ds().channels.findOneBy("channel_id", c.req.param("channelId"));
    if (!channel) return discordError(c, "Unknown Channel", 404, 10003);

    const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 100);
    const before = c.req.query("before");
    const after = c.req.query("after");
    const around = c.req.query("around");

    let messages = ds()
      .messages.findBy("channel_id", channel.channel_id)
      .sort((a, b) => (BigInt(b.message_id) > BigInt(a.message_id) ? 1 : -1));

    if (before) messages = messages.filter((m) => BigInt(m.message_id) < BigInt(before));
    if (after) messages = messages.filter((m) => BigInt(m.message_id) > BigInt(after));
    if (around) {
      const index = messages.findIndex((m) => m.message_id === around);
      if (index >= 0) {
        const half = Math.floor(limit / 2);
        messages = messages.slice(Math.max(0, index - half), index + half + 1);
      }
    }

    return c.json(messages.slice(0, limit).map((m) => formatMessage(m, ctx)));
  });

  app.get("/api/v10/channels/:channelId/messages/:messageId", (c) => {
    const message = ds()
      .messages.findBy("channel_id", c.req.param("channelId"))
      .find((m) => m.message_id === c.req.param("messageId"));
    if (!message) return discordError(c, "Unknown Message", 404, 10008);
    return c.json(formatMessage(message, ctx));
  });

  app.post("/api/v10/channels/:channelId/messages", async (c) => {
    const channel = ds().channels.findOneBy("channel_id", c.req.param("channelId"));
    if (!channel) return discordError(c, "Unknown Channel", 404, 10003);

    const body = await parseJsonBody(c);
    const content = bodyString(body, "content");
    if (!content && !Array.isArray(body.embeds)) return discordError(c, "Cannot send an empty message", 400, 50006);

    const author = getAuthedUser(c, ctx) ?? ds().users.all()[0];
    const message = ds().messages.insert({
      message_id: bodyString(body, "id", generateSnowflake()),
      channel_id: channel.channel_id,
      guild_id: channel.guild_id,
      author_id: author?.user_id ?? "0",
      content,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: bodyBoolean(body, "tts", false),
      mention_everyone: bodyBoolean(body, "mention_everyone", false),
      mention_roles: bodyStringArray(body, "mention_roles"),
      type: 0,
      pinned: false,
    });

    ds().channels.update(channel.id, { last_message_id: message.message_id });

    return c.json(formatMessage(message, ctx), 200);
  });

  app.patch("/api/v10/channels/:channelId/messages/:messageId", async (c) => {
    const message = ds()
      .messages.findBy("channel_id", c.req.param("channelId"))
      .find((m) => m.message_id === c.req.param("messageId"));
    if (!message) return discordError(c, "Unknown Message", 404, 10008);

    const body = await parseJsonBody(c);
    const updated = ds().messages.update(message.id, {
      content: bodyString(body, "content", message.content),
      edited_timestamp: new Date().toISOString(),
    })!;
    return c.json(formatMessage(updated, ctx));
  });

  app.delete("/api/v10/channels/:channelId/messages/:messageId", (c) => {
    const message = ds()
      .messages.findBy("channel_id", c.req.param("channelId"))
      .find((m) => m.message_id === c.req.param("messageId"));
    if (!message) return discordError(c, "Unknown Message", 404, 10008);

    ds().messages.delete(message.id);
    return discordNoContent(c);
  });
}
