import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import {
  bodyBoolean,
  bodyNumber,
  bodyString,
  discordError,
  discordNoContent,
  formatRole,
  generateSnowflake,
  parseJsonBody,
  requireDiscordAuth,
} from "../helpers.js";

export function roleRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.use("/api/v10/guilds/:guildId/roles/*", requireDiscordAuth(ctx));
  app.use("/api/v10/guilds/:guildId/roles", requireDiscordAuth(ctx));

  app.get("/api/v10/guilds/:guildId/roles", (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);
    return c.json(
      ds()
        .roles.findBy("guild_id", guildId)
        .sort((a, b) => a.position - b.position)
        .map(formatRole),
    );
  });

  app.post("/api/v10/guilds/:guildId/roles", async (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    const body = await parseJsonBody(c);
    const role = ds().roles.insert({
      role_id: bodyString(body, "id", generateSnowflake()),
      guild_id: guildId,
      name: bodyString(body, "name", "new role"),
      color: bodyNumber(body, "color", 0),
      hoist: bodyBoolean(body, "hoist", false),
      position: ds().roles.findBy("guild_id", guildId).length,
      permissions: bodyString(body, "permissions", "0"),
      managed: false,
      mentionable: bodyBoolean(body, "mentionable", false),
    });

    return c.json(formatRole(role), 200);
  });

  app.patch("/api/v10/guilds/:guildId/roles/:roleId", async (c) => {
    const role = findRole(ctx, c.req.param("guildId"), c.req.param("roleId"));
    if (!role) return discordError(c, "Unknown Role", 404, 10011);

    const body = await parseJsonBody(c);
    const updated = ds().roles.update(role.id, {
      name: bodyString(body, "name", role.name),
      color: bodyNumber(body, "color", role.color),
      hoist: bodyBoolean(body, "hoist", role.hoist),
      permissions: bodyString(body, "permissions", role.permissions),
      mentionable: bodyBoolean(body, "mentionable", role.mentionable),
    })!;
    return c.json(formatRole(updated));
  });

  app.delete("/api/v10/guilds/:guildId/roles/:roleId", (c) => {
    const role = findRole(ctx, c.req.param("guildId"), c.req.param("roleId"));
    if (!role) return discordError(c, "Unknown Role", 404, 10011);

    for (const member of ds().members.findBy("guild_id", role.guild_id)) {
      if (member.roles.includes(role.role_id)) {
        ds().members.update(member.id, { roles: member.roles.filter((id) => id !== role.role_id) });
      }
    }
    ds().roles.delete(role.id);
    return discordNoContent(c);
  });
}

function findRole(ctx: RouteContext, guildId: string, roleId: string) {
  return getDiscordStore(ctx.store)
    .roles.findBy("guild_id", guildId)
    .find((role) => role.role_id === roleId);
}
