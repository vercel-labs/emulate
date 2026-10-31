import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  type SlackTestApp,
} from "./helpers.js";

const appId = "A_EVENT_APP";
const botId = "B_EVENT_BOT";
const botUserId = "U_EVENT_BOT";
const botToken = "xoxb-event-bot";

function setupApp() {
  const setup = createSlackTestApp();
  seedFromConfig(setup.store, base, {
    verification_token: "event-verification-token",
    users: [{ name: "alice" }],
    channels: [{ name: "events" }, { name: "private-events", is_private: true }],
    oauth_apps: [
      {
        app_id: appId,
        client_id: "event-client",
        client_secret: "event-secret",
        name: "Event Bot",
        bot_id: botId,
        bot_user_id: botUserId,
        redirect_uris: ["https://example.com/callback"],
      },
    ],
    tokens: [{ token: botToken, type: "bot", user_id: botUserId, app_id: appId, bot_id: botId }],
  });
  return setup;
}

async function call(setup: SlackTestApp, method: string, body: Record<string, unknown>, token?: string) {
  const response = await setup.app.request(`${base}/api/${method}`, {
    method: "POST",
    headers: token ? { ...authHeaders(), Authorization: `Bearer ${token}` } : authHeaders(),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

describe("Slack event payload fidelity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["channel", "group", "im", "mpim"])("identifies %s message events across their lifecycle", async (kind) => {
    const setup = setupApp();
    const ss = getSlackStore(setup.store);
    const alice = ss.users.findOneBy("name", "alice")!;
    const channel =
      kind === "channel" || kind === "group"
        ? ss.channels.findOneBy("name", kind === "channel" ? "events" : "private-events")!.channel_id
        : (
            await call(setup, "conversations.open", {
              users: kind === "im" ? botUserId : `${botUserId},${alice.user_id}`,
            })
          ).channel.id;
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);

    const posted = await call(setup, "chat.postMessage", { channel, text: "Hello" });
    await call(setup, "chat.update", { channel, ts: posted.ts, text: "Edited" });
    await call(setup, "chat.delete", { channel, ts: posted.ts });

    const events = capture.jsonBodies() as Array<Record<string, any>>;
    expect(events).toHaveLength(3);
    for (const envelope of events) {
      expect(envelope).toMatchObject({
        token: "event-verification-token",
        api_app_id: appId,
        team_id: "T000000001",
        authorizations: [
          {
            enterprise_id: null,
            team_id: "T000000001",
            user_id: botUserId,
            is_bot: true,
            is_enterprise_install: false,
          },
        ],
        event: { type: "message", channel, channel_type: kind, event_ts: expect.stringMatching(/^\d+\.\d+$/) },
      });
    }
    expect(events[0].event.event_ts).toBe(posted.ts);
    expect(events[1].event.message.ts).toBe(posted.ts);
    expect(events[1].event.event_ts).not.toBe(posted.ts);
    expect(events[2].event.deleted_ts).toBe(posted.ts);
    expect(events[2].event.event_ts).not.toBe(posted.ts);
  });

  it("routes envelopes by recipient app, independently of the message author", async () => {
    const setup = setupApp();
    seedFromConfig(setup.store, base, {
      oauth_apps: [
        {
          app_id: "A_SECOND",
          client_id: "second",
          client_secret: "second-secret",
          name: "Second",
          bot_user_id: "U_SECOND",
          redirect_uris: [],
        },
      ],
    });
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "events")!.channel_id;
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    setup.webhooks.register({ url: "https://hooks.example/other", events: ["message"], owner: "slack", active: true });

    const posted = await call(setup, "chat.postMessage", { channel, text: "From the first app" }, botToken);
    const envelopes = capture.jsonBodies() as Array<Record<string, any>>;
    expect(envelopes).toHaveLength(4);
    expect(envelopes[0]).toEqual(envelopes[1]);
    expect(envelopes[2]).toEqual(envelopes[3]);
    expect(envelopes[0].api_app_id).toBe(appId);
    expect(envelopes[0].authorizations[0].user_id).toBe(botUserId);
    expect(envelopes[2].api_app_id).toBe("A_SECOND");
    expect(envelopes[2].authorizations[0].user_id).toBe("U_SECOND");
    expect(envelopes[0].event_id).not.toBe(envelopes[2].event_id);
    for (const envelope of envelopes) {
      expect(envelope.event).toMatchObject({ user: botUserId, app_id: appId, bot_id: botId, ts: posted.ts });
    }
  });

  it("persists bot identity for self-message filters in responses, callbacks, history, and replies", async () => {
    const setup = setupApp();
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "events")!.channel_id;
    const parent = await call(setup, "chat.postMessage", { channel, text: "Parent" });
    const root = await call(setup, "chat.postMessage", { channel, text: "Bot message" }, botToken);
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    const posted = await call(
      setup,
      "chat.postMessage",
      { channel, text: "Bot reply", thread_ts: parent.ts, bot_id: "B_SPOOF", app_id: "A_SPOOF" },
      botToken,
    );
    expect(posted.ok).toBe(true);
    const expected = {
      user: botUserId,
      bot_id: botId,
      app_id: appId,
      bot_profile: {
        id: botId,
        app_id: appId,
        name: "event-bot",
        deleted: false,
        updated: expect.any(Number),
        team_id: "T000000001",
        icons: expect.any(Object),
      },
    };
    expect(posted.message).toMatchObject(expected);
    expect((capture.jsonBodies()[0] as any).event).toMatchObject(expected);
    const edited = await call(
      setup,
      "chat.update",
      { channel, ts: posted.ts, text: "Updated bot reply", bot_id: "B_SPOOF", app_id: "A_SPOOF" },
      botToken,
    );
    expect(edited.message).toMatchObject(expected);
    expect(await call(setup, "chat.update", { channel, ts: posted.ts }, botToken)).toMatchObject({ error: "no_text" });
    const history = await call(setup, "conversations.history", { channel });
    const replies = await call(setup, "conversations.replies", { channel, ts: parent.ts });
    expect(history.messages.find((message: any) => message.ts === root.ts)).toMatchObject(expected);
    expect(replies.messages.find((message: any) => message.ts === posted.ts)).toMatchObject(expected);
    expect(history.messages.find((message: any) => message.ts === parent.ts)).not.toHaveProperty("bot_id");
  });

  it("uses the bot identity of OAuth-issued tokens and keeps user tokens as human posts", async () => {
    const setup = setupApp();
    const callback = await setup.app.request(`${base}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: "U000000001",
        redirect_uri: "https://example.com/callback",
        client_id: "event-client",
        scope: "chat:write",
        user_scope: "chat:write",
      }),
    });
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code");
    const exchanged = await call(setup, "oauth.v2.access", {
      code,
      client_id: "event-client",
      client_secret: "event-secret",
      redirect_uri: "https://example.com/callback",
    });
    expect(exchanged.ok).toBe(true);
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "events")!.channel_id;
    const botPost = await call(setup, "chat.postMessage", { channel, text: "OAuth bot" }, exchanged.access_token);
    expect(botPost.message).toMatchObject({
      user: botUserId,
      bot_id: botId,
      app_id: appId,
      bot_profile: { id: botId },
    });
    const humanPost = await call(
      setup,
      "chat.postMessage",
      { channel, text: "OAuth human" },
      exchanged.authed_user.access_token,
    );
    expect(humanPost.message.user).toBe("U000000001");
    expect(humanPost.message).not.toHaveProperty("bot_id");
    expect(humanPost.message).not.toHaveProperty("bot_profile");
  });

  it.each(["events", "private-events"])("notifies a removed app in %s for kick and leave", async (name) => {
    const setup = setupApp();
    const channel = getSlackStore(setup.store).channels.findOneBy("name", name)!.channel_id;
    await call(setup, "conversations.invite", { channel, users: botUserId });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["member_left_channel", "channel_left", "group_left"]);

    for (const method of ["conversations.kick", "conversations.leave"]) {
      if (method === "conversations.leave") await call(setup, "conversations.invite", { channel, users: botUserId });
      const response = await call(
        setup,
        method,
        { channel, user: botUserId },
        method === "conversations.leave" ? botToken : undefined,
      );
      expect(response.ok).toBe(true);
      const events = capture.jsonBodies() as Array<Record<string, any>>;
      const [memberLeft, appLeft] = events.slice(-2);
      expect(memberLeft.event).toMatchObject({
        type: "member_left_channel",
        user: botUserId,
        channel,
        event_ts: expect.any(String),
      });
      expect(appLeft).toMatchObject({
        api_app_id: appId,
        authorizations: [expect.objectContaining({ user_id: botUserId, is_bot: true })],
        event: {
          type: name === "events" ? "channel_left" : "group_left",
          channel,
          actor_id: method === "conversations.leave" ? botUserId : "U000000001",
          event_ts: memberLeft.event.event_ts,
        },
      });
    }
    expect(capture.requests).toHaveLength(4);
    const rejected = await call(setup, "conversations.kick", { channel, user: botUserId });
    expect(rejected.ok).toBe(false);
    expect(capture.requests).toHaveLength(4);
  });

  it("does not emit bot departure callbacks for a human leaving", async () => {
    const setup = setupApp();
    const ss = getSlackStore(setup.store);
    const channel = ss.channels.findOneBy("name", "events")!.channel_id;
    const alice = ss.users.findOneBy("name", "alice")!;
    await call(setup, "conversations.invite", { channel, users: alice.user_id });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["member_left_channel", "channel_left", "group_left"]);
    await call(setup, "conversations.kick", { channel, user: alice.user_id });
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ type: "member_left_channel", user: alice.user_id }) }),
    ]);
  });

  it("adds message event fields to incoming webhook posts", async () => {
    const setup = setupApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    const response = await setup.app.request(`${base}/services/T000000001/${botId}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "events", text: "Webhook message" }),
    });
    expect(await response.text()).toBe("ok");
    const event = (capture.jsonBodies()[0] as any).event;
    expect(event).toMatchObject({
      type: "message",
      channel_type: "channel",
      event_ts: event.ts,
      bot_id: botId,
      app_id: appId,
      bot_profile: { id: botId },
    });
  });

  it("keeps a complete default envelope when no app is installed", async () => {
    const setup = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["message"]);
    await call(setup, "chat.postMessage", { channel: "general", text: "Development message" });
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        token: "emulate-verification-token",
        api_app_id: "A000000001",
        authorizations: [expect.objectContaining({ user_id: "U000000001", is_bot: false })],
      }),
    ]);
  });
});
