import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import {
  bodyBoolean,
  bodyString,
  bodyStringArray,
  discordError,
  discordNoContent,
  formatMember,
  generateSnowflake,
  parseJsonBody,
  requireDiscordAuth,
} from "../helpers.js";

export function memberRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.use("/api/v10/guilds/:guildId/members/*", requireDiscordAuth(ctx));
  app.use("/api/v10/guilds/:guildId/members", requireDiscordAuth(ctx));

  app.get("/api/v10/guilds/:guildId/members", (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    const limit = Math.min(Number(c.req.query("limit") ?? "1") || 1, 1000);
    const after = c.req.query("after") ?? "0";
    const members = ds()
      .members.findBy("guild_id", guildId)
      .filter((m) => BigInt(m.user_id) > BigInt(after))
      .sort((a, b) => (BigInt(a.user_id) > BigInt(b.user_id) ? 1 : -1))
      .slice(0, limit);

    return c.json(members.map((m) => formatMember(m, ds().users.findOneBy("user_id", m.user_id))));
  });

  app.get("/api/v10/guilds/:guildId/members/:userId", (c) => {
    const member = findMember(ctx, c.req.param("guildId"), c.req.param("userId"));
    if (!member) return discordError(c, "Unknown Member", 404, 10007);
    return c.json(formatMember(member, ds().users.findOneBy("user_id", member.user_id)));
  });

  app.put("/api/v10/guilds/:guildId/members/:userId", async (c) => {
    const guildId = c.req.param("guildId");
    const guild = ds().guilds.findOneBy("guild_id", guildId);
    if (!guild) return discordError(c, "Unknown Guild", 404, 10004);

    const userId = c.req.param("userId");
    const body = await parseJsonBody(c);
    let user = ds().users.findOneBy("user_id", userId);
    if (!user) {
      user = ds().users.insert({
        user_id: userId || generateSnowflake(),
        username: bodyString(body, "username", `user-${userId}`),
        discriminator: "0000",
        global_name: bodyString(body, "global_name", "") || null,
        avatar: null,
        bot: false,
        email: bodyString(body, "email", "") || null,
      });
    }

    const existing = findMember(ctx, guildId, user.user_id);
    const data = {
      guild_id: guildId,
      user_id: user.user_id,
      nick: bodyString(body, "nick", existing?.nick ?? "") || null,
      roles: bodyStringArray(body, "roles", existing?.roles ?? []),
      joined_at: existing?.joined_at ?? new Date().toISOString(),
      deaf: bodyBoolean(body, "deaf", existing?.deaf ?? false),
      mute: bodyBoolean(body, "mute", existing?.mute ?? false),
    };

    const member = existing ? ds().members.update(existing.id, data)! : ds().members.insert(data);
    return c.json(formatMember(member, user), existing ? 200 : 201);
  });

  app.patch("/api/v10/guilds/:guildId/members/:userId", async (c) => {
    const member = findMember(ctx, c.req.param("guildId"), c.req.param("userId"));
    if (!member) return discordError(c, "Unknown Member", 404, 10007);

    const body = await parseJsonBody(c);
    const updated = ds().members.update(member.id, {
      nick: body.nick === null ? null : bodyString(body, "nick", member.nick ?? "") || member.nick,
      roles: bodyStringArray(body, "roles", member.roles),
      deaf: bodyBoolean(body, "deaf", member.deaf),
      mute: bodyBoolean(body, "mute", member.mute),
    })!;
    return c.json(formatMember(updated, ds().users.findOneBy("user_id", updated.user_id)));
  });

  app.delete("/api/v10/guilds/:guildId/members/:userId", (c) => {
    const member = findMember(ctx, c.req.param("guildId"), c.req.param("userId"));
    if (!member) return discordError(c, "Unknown Member", 404, 10007);
    ds().members.delete(member.id);
    return discordNoContent(c);
  });
}

function findMember(ctx: RouteContext, guildId: string, userId: string) {
  return getDiscordStore(ctx.store)
    .members.findBy("guild_id", guildId)
    .find((member) => member.user_id === userId);
}
