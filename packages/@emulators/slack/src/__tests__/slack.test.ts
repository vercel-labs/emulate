import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { slackPlugin, seedFromConfig, getSlackStore } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("xoxb-test-token", {
    login: "U000000001",
    id: 1,
    scopes: ["chat:write", "channels:read", "users:read", "reactions:write"],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  slackPlugin.register(app as any, store, webhooks, base, tokenMap);
  slackPlugin.seed!(store, base);

  // Set the test user_id to match the token
  const ss = getSlackStore(store);
  const firstUser = ss.users.all()[0];
  if (firstUser) {
    ss.users.update(firstUser.id, { user_id: "U000000001" });
  }

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer xoxb-test-token", "Content-Type": "application/json" };
}

describe("Slack plugin - auth.test", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("returns user and team info", async () => {
    const res = await app.request(`${base}/api/auth.test`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.user_id).toBe("U000000001");
    expect(body.team).toBeDefined();
  });

  it("returns error without auth", async () => {
    const res = await app.request(`${base}/api/auth.test`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_authed");
  });
});

describe("Slack plugin - chat.postMessage", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("posts a message to a channel", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "hello world" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.ts).toBeDefined();
    expect(body.message.text).toBe("hello world");
  });

  it("posts a message by channel name", async () => {
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "general", text: "by name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it("returns error for missing channel", async () => {
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "nonexistent", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("channel_not_found");
  });

  it("posts a threaded reply", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    // Post parent message
    const parentRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "parent" }),
    });
    const parent = await parentRes.json() as any;

    // Post reply
    const replyRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reply", thread_ts: parent.ts }),
    });
    const reply = await replyRes.json() as any;
    expect(reply.ok).toBe(true);
    expect(reply.message.thread_ts).toBe(parent.ts);
  });

  it("handles form-urlencoded body", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-test-token", "Content-Type": "application/x-www-form-urlencoded" },
      body: `channel=${ch.channel_id}&text=urlencoded+message`,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.message.text).toBe("urlencoded message");
  });
});

describe("Slack plugin - chat.update", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("updates a message", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "original" }),
    });
    const posted = await postRes.json() as any;

    const updateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts, text: "updated" }),
    });
    const updated = await updateRes.json() as any;
    expect(updated.ok).toBe(true);
    expect(updated.text).toBe("updated");
  });
});

describe("Slack plugin - chat.delete", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("deletes a message", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "to delete" }),
    });
    const posted = await postRes.json() as any;

    const deleteRes = await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts }),
    });
    const deleted = await deleteRes.json() as any;
    expect(deleted.ok).toBe(true);
  });
});

describe("Slack plugin - conversations", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("lists channels", async () => {
    const res = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.channels.length).toBeGreaterThanOrEqual(2);
    expect(body.channels[0].name).toBeDefined();
  });

  it("gets channel info", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.channel.id).toBe(ch.channel_id);
    expect(body.channel.name).toBe(ch.name);
  });

  it("creates a channel", async () => {
    const res = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "test-channel" }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.channel.name).toBe("test-channel");
    expect(body.channel.id).toMatch(/^C/);
  });

  it("rejects duplicate channel name", async () => {
    const res = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "general" }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("name_taken");
  });

  it("gets conversation history", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    // Post some messages
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "msg 1" }),
    });
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "msg 2" }),
    });

    const res = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.messages.length).toBe(2);
  });

  it("gets thread replies", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const parentRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "parent" }),
    });
    const parent = await parentRes.json() as any;

    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reply 1", thread_ts: parent.ts }),
    });
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reply 2", thread_ts: parent.ts }),
    });

    const res = await app.request(`${base}/api/conversations.replies`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: parent.ts }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.messages.length).toBe(3); // parent + 2 replies (Slack includes the parent)
  });

  it("joins and leaves a channel", async () => {
    // Create a new channel
    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "join-test" }),
    });
    const created = await createRes.json() as any;
    const channelId = created.channel.id;

    // Leave
    const leaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    expect((await leaveRes.json() as any).ok).toBe(true);

    // Rejoin
    const joinRes = await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const joined = await joinRes.json() as any;
    expect(joined.ok).toBe(true);
    expect(joined.channel.num_members).toBe(1);
  });

  it("lists channel members", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/conversations.members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.members.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Slack plugin - users", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists users", async () => {
    const res = await app.request(`${base}/api/users.list`, {
      method: "POST",
      headers: authHeaders(),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.members.length).toBeGreaterThanOrEqual(1);
    expect(body.members[0].name).toBeDefined();
  });

  it("gets user info", async () => {
    const res = await app.request(`${base}/api/users.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user: "U000000001" }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("U000000001");
  });

  it("looks up user by email", async () => {
    const res = await app.request(`${base}/api/users.lookupByEmail`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "admin@emulate.dev" }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.user.profile.email).toBe("admin@emulate.dev");
  });

  it("returns error for unknown user", async () => {
    const res = await app.request(`${base}/api/users.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user: "U999999999" }),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("user_not_found");
  });
});

describe("Slack plugin - reactions", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("adds and gets a reaction", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    // Post a message
    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "react to me" }),
    });
    const posted = await postRes.json() as any;

    // Add reaction
    const addRes = await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "thumbsup" }),
    });
    expect((await addRes.json() as any).ok).toBe(true);

    // Get reactions
    const getRes = await app.request(`${base}/api/reactions.get`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });
    const body = await getRes.json() as any;
    expect(body.ok).toBe(true);
    expect(body.message.reactions[0].name).toBe("thumbsup");
    expect(body.message.reactions[0].count).toBe(1);
  });

  it("removes a reaction", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "react and remove" }),
    });
    const posted = await postRes.json() as any;

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "thumbsup" }),
    });

    const removeRes = await app.request(`${base}/api/reactions.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "thumbsup" }),
    });
    expect((await removeRes.json() as any).ok).toBe(true);

    // Verify removed
    const getRes = await app.request(`${base}/api/reactions.get`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });
    const body = await getRes.json() as any;
    expect(body.message.reactions).toEqual([]);
  });

  it("rejects duplicate reaction", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "double react" }),
    });
    const posted = await postRes.json() as any;

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "heart" }),
    });

    const dupeRes = await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "heart" }),
    });
    const dupe = await dupeRes.json() as any;
    expect(dupe.ok).toBe(false);
    expect(dupe.error).toBe("already_reacted");
  });
});

describe("Slack plugin - team.info", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("returns team info", async () => {
    const res = await app.request(`${base}/api/team.info`, {
      method: "POST",
      headers: authHeaders(),
    });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.team.name).toBe("Emulate");
    expect(body.team.domain).toBe("emulate");
  });
});

describe("Slack plugin - seedFromConfig", () => {
  it("seeds custom team, users, channels, and bots", () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const app = new Hono();
    slackPlugin.register(app as any, store, webhooks, base);
    slackPlugin.seed!(store, base);

    seedFromConfig(store, base, {
      team: { name: "Acme Corp", domain: "acme" },
      users: [
        { name: "alice", real_name: "Alice Smith", email: "alice@acme.com", is_admin: true },
        { name: "bob", email: "bob@acme.com" },
      ],
      channels: [
        { name: "engineering", topic: "Code talk" },
        { name: "secret", is_private: true },
      ],
      bots: [{ name: "deploy-bot" }],
    });

    const ss = getSlackStore(store);

    const team = ss.teams.all()[0];
    expect(team.name).toBe("Acme Corp");
    expect(team.domain).toBe("acme");

    const users = ss.users.all();
    expect(users.length).toBe(3); // admin + alice + bob

    const channels = ss.channels.all();
    expect(channels.length).toBe(4); // general + random + engineering + secret
    const eng = channels.find((c) => c.name === "engineering");
    expect(eng?.topic.value).toBe("Code talk");
    const secret = channels.find((c) => c.name === "secret");
    expect(secret?.is_private).toBe(true);

    const bots = ss.bots.all();
    expect(bots.length).toBe(1);
    expect(bots[0].name).toBe("deploy-bot");
  });
});

describe("Slack plugin - OAuth flow", () => {
  let app: Hono;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    const ss = getSlackStore(setup.store);
    ss.oauthApps.insert({
      client_id: "12345.67890",
      client_secret: "test-secret",
      name: "Test App",
      redirect_uris: ["http://localhost:3000/callback"],
    });
  });

  it("renders the consent page", async () => {
    const res = await app.request(
      `${base}/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz`
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to Slack");
    expect(html).toContain("Test App");
    expect(html).toContain("Slack Emulator");
  });

  it("rejects unknown client_id", async () => {
    const res = await app.request(`${base}/oauth/v2/authorize?client_id=invalid&redirect_uri=http://localhost:3000/callback`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
  });

  it("completes the token exchange", async () => {
    // Get the consent page to verify it loads
    const authRes = await app.request(
      `${base}/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz`
    );
    expect(authRes.status).toBe(200);

    // Simulate the callback (user clicks approve)
    const callbackRes = await app.request(`${base}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `user_id=U000000001&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz&client_id=12345.67890`,
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toBeDefined();

    // Exchange code for token
    const tokenRes = await app.request(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `code=${code}&client_id=12345.67890&client_secret=test-secret`,
    });
    const token = await tokenRes.json() as any;
    expect(token.ok).toBe(true);
    expect(token.access_token).toMatch(/^xoxb-/);
    expect(token.team.name).toBe("Emulate");
    expect(token.authed_user.id).toBe("U000000001");
  });
});

describe("Slack plugin - Incoming Webhooks", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("posts a message via incoming webhook", async () => {
    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0];
    expect(webhook).toBeDefined();

    const res = await app.request(`${base}${webhook.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Deploy succeeded!" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Verify message was stored
    const messages = ss.messages.findBy("channel_id", "C000000001");
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe("Deploy succeeded!");
    expect(messages[0].subtype).toBe("bot_message");
  });

  it("posts to a specific channel via webhook", async () => {
    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0];

    const res = await app.request(`${base}${webhook.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Random message", channel: "random" }),
    });
    expect(res.status).toBe(200);

    const randomCh = ss.channels.findOneBy("name", "random")!;
    const messages = ss.messages.findBy("channel_id", randomCh.channel_id);
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe("Random message");
  });

  it("rejects empty webhook payload", async () => {
    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0];

    const res = await app.request(`${base}${webhook.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("Slack plugin - Message Inspector", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("renders the message inspector page", async () => {
    const res = await app.request(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Message Inspector");
    expect(html).toContain("general");
    expect(html).toContain("random");
    expect(html).toContain("Slack Emulator");
  });

  it("shows posted messages in the inspector", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    // Post a message first
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "Inspector test message" }),
    });

    const res = await app.request(`${base}/?channel=${ch.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Inspector test message");
  });

  it("switches channels via query param", async () => {
    const ss = getSlackStore(store);
    const randomCh = ss.channels.findOneBy("name", "random")!;

    const res = await app.request(`${base}/?channel=${randomCh.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("random");
    expect(html).toContain("Random stuff");
  });
});
