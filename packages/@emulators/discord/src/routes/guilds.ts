import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import {
  bodyString,
  discordError,
  discordNoContent,
  formatGuild,
  generateSnowflake,
  parseJsonBody,
  requireDiscordAuth,
} from "../helpers.js";

export function guildRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.use("/api/v10/guilds/*", requireDiscordAuth(ctx));
  app.use("/api/v10/guilds", requireDiscordAuth(ctx));

  app.get("/api/v10/guilds", (c) => {
    return c.json(ds().guilds.all().map(formatGuild));
  });

  app.post("/api/v10/guilds", async (c) => {
    const body = await parseJsonBody(c);
    const name = bodyString(body, "name");
    if (!name) return discordError(c, "Invalid Form Body", 400, 50035);

    const ownerId = bodyString(body, "owner_id", ds().users.all()[0]?.user_id ?? "0");
    const guildId = bodyString(body, "id", generateSnowflake());
    const guild = ds().guilds.insert({
      guild_id: guildId,
      name,
      icon: bodyString(body, "icon", "") || null,
      owner_id: ownerId,
      description: bodyString(body, "description", "") || null,
    });

    ds().roles.insert({
      role_id: guildId,
      guild_id: guildId,
      name: "@everyone",
      color: 0,
      hoist: false,
      position: 0,
      permissions: "0",
      managed: false,
      mentionable: false,
    });

    return c.json(formatGuild(guild), 201);
  });

  app.get("/api/v10/guilds/:guildId", (c) => {
    const guild = ds().guilds.findOneBy("guild_id", c.req.param("guildId"));
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);
    return c.json(formatGuild(guild));
  });

  app.patch("/api/v10/guilds/:guildId", async (c) => {
    const guild = ds().guilds.findOneBy("guild_id", c.req.param("guildId"));
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    const body = await parseJsonBody(c);
    const updated = ds().guilds.update(guild.id, {
      name: bodyString(body, "name", guild.name),
      icon: body.icon === null ? null : bodyString(body, "icon", guild.icon ?? "") || guild.icon,
      description:
        body.description === null
          ? null
          : bodyString(body, "description", guild.description ?? "") || guild.description,
    })!;
    return c.json(formatGuild(updated));
  });

  app.delete("/api/v10/guilds/:guildId", (c) => {
    const guild = ds().guilds.findOneBy("guild_id", c.req.param("guildId"));
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    for (const channel of ds().channels.findBy("guild_id", guild.guild_id)) ds().channels.delete(channel.id);
    for (const role of ds().roles.findBy("guild_id", guild.guild_id)) ds().roles.delete(role.id);
    for (const member of ds().members.findBy("guild_id", guild.guild_id)) ds().members.delete(member.id);
    for (const message of ds().messages.findBy("guild_id", guild.guild_id)) ds().messages.delete(message.id);
    ds().guilds.delete(guild.id);

    return discordNoContent(c);
  });
}
