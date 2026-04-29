import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { discordPlugin, generateSnowflake, getDiscordStore, seedFromConfig, snowflakeTimestamp } from "../index.js";
import { resetSnowflakeGenerator } from "../helpers.js";

const base = "http://localhost:4012";
const botToken = "discord-bot-token";
const bearerToken = "discord-bearer-token";
const userId = "222222222222222222";
const guildId = "333333333333333333";
const channelId = "555555555555555555";
const roleId = "444444444444444444";

function createTestApp() {
  const app = new Hono();
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set(bearerToken, { login: userId, id: 100, scopes: ["identify", "guilds"] });

  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  discordPlugin.register(app as never, store, webhooks, base, tokenMap);
  discordPlugin.seed!(store, base);
  seedFromConfig(
    store,
    base,
    {
      applications: [
        {
          id: "123456789012345678",
          client_id: "discord-client-id",
          client_secret: "discord-client-secret",
          name: "My Discord App",
          bot_token: botToken,
          redirect_uris: ["http://localhost:3000/callback"],
        },
      ],
      users: [{ id: userId, username: "developer", email: "dev@example.com" }],
      guilds: [
        {
          id: guildId,
          name: "My Server",
          roles: [{ id: roleId, name: "admin", permissions: "8" }],
          members: [{ user_id: userId, roles: [roleId] }],
          channels: [{ id: channelId, name: "general", type: "GUILD_TEXT" }],
        },
      ],
    },
    webhooks,
  );

  return { app, store, tokenMap };
}

function botHeaders() {
  return { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" };
}

function bearerHeaders() {
  return { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" };
}

describe("Discord snowflakes", () => {
  beforeEach(() => resetSnowflakeGenerator());

  it("encodes Discord epoch milliseconds in the high bits", () => {
    const date = new Date("2026-04-29T12:00:00.000Z");
    const id = generateSnowflake(date);
    expect(snowflakeTimestamp(id)).toBe(date.getTime());
  });

  it("uses a 12-bit sequence for IDs generated in the same millisecond", () => {
    const date = new Date("2026-04-29T12:00:00.000Z");
    const first = BigInt(generateSnowflake(date));
    const second = BigInt(generateSnowflake(date));
    expect(second - first).toBe(1n);
    expect(Number(first & 0xfffn)).toBe(0);
    expect(Number(second & 0xfffn)).toBe(1);
  });

  it("returns string-encoded 64-bit numeric IDs", () => {
    const id = generateSnowflake();
    expect(typeof id).toBe("string");
    expect(/^\d+$/.test(id)).toBe(true);
    expect(BigInt(id)).toBeGreaterThan(0n);
  });
});

describe("Discord auth and users", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("accepts Bot authorization headers", async () => {
    const res = await app.request(`${base}/api/v10/users/@me`, { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.bot).toBe(true);
  });

  it("accepts Bearer authorization headers", async () => {
    const res = await app.request(`${base}/api/v10/users/@me`, { headers: bearerHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(userId);
  });

  it("rejects unauthenticated REST calls", async () => {
    const res = await app.request(`${base}/api/v10/guilds`);
    expect(res.status).toBe(401);
  });
});

describe("Discord guilds", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists guilds", async () => {
    const res = await app.request(`${base}/api/v10/guilds`, { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.some((guild) => guild.id === guildId)).toBe(true);
  });

  it("gets a guild", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}`, { headers: botHeaders() });
    const body = (await res.json()) as any;
    expect(body.name).toBe("My Server");
  });

  it("creates a guild with an @everyone role", async () => {
    const res = await app.request(`${base}/api/v10/guilds`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Created Guild", owner_id: userId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Created Guild");
  });

  it("updates a guild", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Renamed Server" }),
    });
    const body = (await res.json()) as any;
    expect(body.name).toBe("Renamed Server");
  });

  it("deletes a guild and related state", async () => {
    const { app: localApp, store } = createTestApp();
    const res = await localApp.request(`${base}/api/v10/guilds/${guildId}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).channels.findBy("guild_id", guildId)).toHaveLength(0);
  });
});

describe("Discord channels and messages", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists guild channels", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/channels`, { headers: botHeaders() });
    const body = (await res.json()) as any[];
    expect(body[0].name).toBe("general");
  });

  it("creates a channel", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/channels`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "announcements", topic: "Updates" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.name).toBe("announcements");
  });

  it("gets a channel", async () => {
    const res = await app.request(`${base}/api/v10/channels/${channelId}`, { headers: botHeaders() });
    const body = (await res.json()) as any;
    expect(body.id).toBe(channelId);
  });

  it("updates a channel", async () => {
    const res = await app.request(`${base}/api/v10/channels/${channelId}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ topic: "New topic" }),
    });
    const body = (await res.json()) as any;
    expect(body.topic).toBe("New topic");
  });

  it("deletes a channel", async () => {
    const res = await app.request(`${base}/api/v10/channels/${channelId}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it("creates a message", async () => {
    const res = await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hello discord" }),
    });
    const body = (await res.json()) as any;
    expect(body.content).toBe("hello discord");
    expect(body.id).toBeDefined();
  });

  it("lists messages newest first", async () => {
    await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "first" }),
    });
    await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "second" }),
    });
    const res = await app.request(`${base}/api/v10/channels/${channelId}/messages`, { headers: botHeaders() });
    const body = (await res.json()) as any[];
    expect(body[0].content).toBe("second");
  });

  it("gets a message", async () => {
    const created = await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "fetch me" }),
    });
    const msg = (await created.json()) as any;
    const res = await app.request(`${base}/api/v10/channels/${channelId}/messages/${msg.id}`, {
      headers: botHeaders(),
    });
    const body = (await res.json()) as any;
    expect(body.content).toBe("fetch me");
  });

  it("updates a message", async () => {
    const created = await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "before" }),
    });
    const msg = (await created.json()) as any;
    const res = await app.request(`${base}/api/v10/channels/${channelId}/messages/${msg.id}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "after" }),
    });
    const body = (await res.json()) as any;
    expect(body.content).toBe("after");
    expect(body.edited_timestamp).toBeTruthy();
  });

  it("deletes a message", async () => {
    const created = await app.request(`${base}/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "delete me" }),
    });
    const msg = (await created.json()) as any;
    const res = await app.request(`${base}/api/v10/channels/${channelId}/messages/${msg.id}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });
});

describe("Discord members and roles", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists members", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/members?limit=10`, { headers: botHeaders() });
    const body = (await res.json()) as any[];
    expect(body.some((member) => member.user.id === userId)).toBe(true);
  });

  it("gets a member", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/members/${userId}`, { headers: botHeaders() });
    const body = (await res.json()) as any;
    expect(body.user.id).toBe(userId);
  });

  it("adds a member", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/members/666666666666666666`, {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ username: "new-user", roles: [roleId] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.roles).toEqual([roleId]);
  });

  it("updates a member", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/members/${userId}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ nick: "Dev" }),
    });
    const body = (await res.json()) as any;
    expect(body.nick).toBe("Dev");
  });

  it("deletes a member", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/members/${userId}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("lists roles", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/roles`, { headers: botHeaders() });
    const body = (await res.json()) as any[];
    expect(body.some((role) => role.id === roleId)).toBe(true);
  });

  it("creates a role", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/roles`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "moderator", permissions: "4", mentionable: true }),
    });
    const body = (await res.json()) as any;
    expect(body.name).toBe("moderator");
    expect(body.mentionable).toBe(true);
  });

  it("updates a role", async () => {
    const res = await app.request(`${base}/api/v10/guilds/${guildId}/roles/${roleId}`, {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "owner" }),
    });
    const body = (await res.json()) as any;
    expect(body.name).toBe("owner");
  });

  it("deletes a role and removes it from members", async () => {
    const { app: localApp, store } = createTestApp();
    const res = await localApp.request(`${base}/api/v10/guilds/${guildId}/roles/${roleId}`, {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    const member = getDiscordStore(store).members.findOneBy("user_id", userId);
    expect(member?.roles).not.toContain(roleId);
  });
});

describe("Discord OAuth", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("renders the authorization page", async () => {
    const res = await app.request(
      `${base}/oauth2/authorize?client_id=discord-client-id&redirect_uri=http://localhost:3000/callback&scope=identify%20guilds&state=abc`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign in to Discord");
  });

  it("rejects unknown OAuth clients", async () => {
    const res = await app.request(
      `${base}/oauth2/authorize?client_id=missing&redirect_uri=http://localhost:3000/callback`,
    );
    expect(res.status).toBe(400);
  });

  it("completes authorization code flow", async () => {
    const callback = await app.request(`${base}/oauth2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: userId,
        client_id: "discord-client-id",
        redirect_uri: "http://localhost:3000/callback",
        scope: "identify guilds",
        state: "state-value",
      }).toString(),
    });
    expect(callback.status).toBe(302);
    const location = callback.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;

    const token = await app.request(`${base}/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "discord-client-id",
        client_secret: "discord-client-secret",
        code,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as any;
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^discord_/);
  });

  it("rejects reused authorization codes", async () => {
    const callback = await app.request(`${base}/oauth2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: userId,
        client_id: "discord-client-id",
        redirect_uri: "http://localhost:3000/callback",
      }).toString(),
    });
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const body = new URLSearchParams({
      client_id: "discord-client-id",
      client_secret: "discord-client-secret",
      code,
    }).toString();

    await app.request(`${base}/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const second = await app.request(`${base}/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(second.status).toBe(400);
  });
});

describe("Discord inspector", () => {
  it("renders inspector tabs", async () => {
    const app = createTestApp().app;
    const res = await app.request(`${base}/?tab=messages`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Discord Inspector");
    expect(html).toContain("Messages");
  });
});
