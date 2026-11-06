import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import {
  bodyBoolean,
  bodyNumber,
  bodyString,
  discordError,
  formatChannel,
  generateSnowflake,
  parseJsonBody,
  requireDiscordAuth,
} from "../helpers.js";
import type { DiscordChannelType } from "../entities.js";

export function channelRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.use("/api/v10/channels/*", requireDiscordAuth(ctx));

  app.get("/api/v10/guilds/:guildId/channels", (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);
    return c.json(ds().channels.findBy("guild_id", guildId).map(formatChannel));
  });

  app.post("/api/v10/guilds/:guildId/channels", async (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    const body = await parseJsonBody(c);
    const name = bodyString(body, "name");
    if (!name) return discordError(c, "Invalid Form Body", 400, 50035);

    const channel = ds().channels.insert({
      channel_id: bodyString(body, "id", generateSnowflake()),
      guild_id: guildId,
      name,
      type: bodyNumber(body, "type", 0) as DiscordChannelType,
      topic: bodyString(body, "topic", "") || null,
      position: bodyNumber(body, "position", ds().channels.findBy("guild_id", guildId).length),
      parent_id: bodyString(body, "parent_id", "") || null,
      nsfw: bodyBoolean(body, "nsfw", false),
      last_message_id: null,
    });

    return c.json(formatChannel(channel), 201);
  });

  app.get("/api/v10/channels/:channelId", (c) => {
    const channel = ds().channels.findOneBy("channel_id", c.req.param("channelId"));
    if (!channel) return discordError(c, "Unknown Channel", 404, 10003);
    return c.json(formatChannel(channel));
  });

  app.patch("/api/v10/channels/:channelId", async (c) => {
    const channel = ds().channels.findOneBy("channel_id", c.req.param("channelId"));
    if (!channel) return discordError(c, "Unknown Channel", 404, 10003);

    const body = await parseJsonBody(c);
    const updated = ds().channels.update(channel.id, {
      name: bodyString(body, "name", channel.name),
      topic: body.topic === null ? null : bodyString(body, "topic", channel.topic ?? "") || channel.topic,
      position: bodyNumber(body, "position", channel.position),
      parent_id:
        body.parent_id === null ? null : bodyString(body, "parent_id", channel.parent_id ?? "") || channel.parent_id,
      nsfw: bodyBoolean(body, "nsfw", channel.nsfw),
    })!;

    return c.json(formatChannel(updated));
  });

  app.delete("/api/v10/channels/:channelId", (c) => {
    const channel = ds().channels.findOneBy("channel_id", c.req.param("channelId"));
    if (!channel) return discordError(c, "Unknown Channel", 404, 10003);

    for (const message of ds().messages.findBy("channel_id", channel.channel_id)) ds().messages.delete(message.id);
    ds().channels.delete(channel.id);

    return c.json(formatChannel(channel));
  });
}
