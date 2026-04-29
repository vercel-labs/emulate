import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext, TokenMap } from "@emulators/core";
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordMessage,
  DiscordRole,
  DiscordUser,
} from "./entities.js";
import { getDiscordStore } from "./store.js";

const DISCORD_EPOCH = 1420070400000n;
const WORKER_ID = 1n;
const PROCESS_ID = 1n;

let lastTimestamp = 0n;
let sequence = 0n;

export function generateSnowflake(date: Date = new Date()): string {
  let timestamp = BigInt(date.getTime());
  if (timestamp < DISCORD_EPOCH) timestamp = DISCORD_EPOCH;

  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) timestamp += 1n;
  } else {
    sequence = 0n;
  }

  lastTimestamp = timestamp;

  return (
    ((timestamp - DISCORD_EPOCH) << 22n) |
    ((WORKER_ID & 0x1fn) << 17n) |
    ((PROCESS_ID & 0x1fn) << 12n) |
    sequence
  ).toString();
}

export function snowflakeTimestamp(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function resetSnowflakeGenerator(): void {
  lastTimestamp = 0n;
  sequence = 0n;
}

export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function discordError(c: Context, message: string, status: ContentfulStatusCode = 400, code = 0) {
  return c.json({ message, code }, status);
}

export function discordNoContent(c: Context) {
  return c.body(null, 204);
}

export function bodyString(body: Record<string, unknown>, key: string, fallback = ""): string {
  const value = body[key];
  return typeof value === "string" ? value : fallback;
}

export function bodyBoolean(body: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = body[key];
  if (typeof value === "boolean") return value;
  return fallback;
}

export function bodyNumber(body: Record<string, unknown>, key: string, fallback = 0): number {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

export function bodyStringArray(body: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : fallback;
}

export function extractDiscordToken(authHeader: string | undefined): string {
  if (!authHeader) return "";
  return authHeader.replace(/^(Bearer|Bot|token)\s+/i, "").trim();
}

export function installDiscordToken(tokenMap: TokenMap | undefined, token: string, login: string, id = 1): void {
  if (!tokenMap || !token) return;
  tokenMap.set(token, { login, id, scopes: ["identify", "guilds", "bot"] });
  tokenMap.set(`Bot ${token}`, { login, id, scopes: ["bot"] });
}

export function requireDiscordAuth(ctx: RouteContext) {
  return async (c: Context, next: Next) => {
    const existing = c.get("authUser");
    if (existing) {
      await next();
      return;
    }

    const token = extractDiscordToken(c.req.header("Authorization"));
    const mapped = token ? (ctx.tokenMap?.get(token) ?? ctx.tokenMap?.get(`Bot ${token}`)) : undefined;
    if (!mapped) {
      return discordError(c, "401: Unauthorized", 401, 0);
    }

    c.set("authUser", mapped);
    c.set("authToken", token);
    c.set("authScopes", mapped.scopes);
    await next();
  };
}

export function formatUser(user: DiscordUser) {
  return {
    id: user.user_id,
    username: user.username,
    discriminator: user.discriminator,
    global_name: user.global_name ?? null,
    avatar: user.avatar ?? null,
    bot: user.bot,
    ...(user.email ? { email: user.email } : {}),
  };
}

export function formatGuild(guild: DiscordGuild) {
  return {
    id: guild.guild_id,
    name: guild.name,
    icon: guild.icon ?? null,
    owner_id: guild.owner_id,
    description: guild.description ?? null,
  };
}

export function formatRole(role: DiscordRole) {
  return {
    id: role.role_id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    position: role.position,
    permissions: role.permissions,
    managed: role.managed,
    mentionable: role.mentionable,
  };
}

export function formatMember(member: DiscordMember, user?: DiscordUser) {
  return {
    user: user ? formatUser(user) : { id: member.user_id },
    nick: member.nick ?? null,
    roles: member.roles,
    joined_at: member.joined_at,
    deaf: member.deaf,
    mute: member.mute,
  };
}

export function formatChannel(channel: DiscordChannel) {
  return {
    id: channel.channel_id,
    type: channel.type,
    guild_id: channel.guild_id,
    name: channel.name,
    topic: channel.topic ?? null,
    position: channel.position,
    parent_id: channel.parent_id ?? null,
    nsfw: channel.nsfw,
    last_message_id: channel.last_message_id ?? null,
  };
}

export function formatMessage(message: DiscordMessage, ctx: RouteContext) {
  const ds = getDiscordStore(ctx.store);
  const author = ds.users.findOneBy("user_id", message.author_id);
  return {
    id: message.message_id,
    channel_id: message.channel_id,
    guild_id: message.guild_id,
    author: author ? formatUser(author) : { id: message.author_id },
    content: message.content,
    timestamp: message.timestamp,
    edited_timestamp: message.edited_timestamp ?? null,
    tts: message.tts,
    mention_everyone: message.mention_everyone,
    mention_roles: message.mention_roles,
    type: message.type,
    pinned: message.pinned,
  };
}

export function getAuthedUser(c: Context, ctx: RouteContext): DiscordUser | undefined {
  const auth = c.get("authUser");
  if (!auth) return undefined;
  const ds = getDiscordStore(ctx.store);
  return ds.users.findOneBy("user_id", auth.login) ?? ds.users.all()[0];
}
