import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import { SLACK_MESSAGE_TEXT_LIMIT } from "../helpers.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  type SlackTestApp,
} from "./helpers.js";

const botUserId = "U000000777";
const appId = "A000000777";

function createMentionTestApp() {
  const setup = createSlackTestApp();
  seedFromConfig(setup.store, base, {
    users: [{ name: "alice" }],
    channels: [{ name: "mentions" }, { name: "private-mentions", is_private: true }],
    oauth_apps: [
      {
        app_id: appId,
        client_id: "mention-client",
        client_secret: "mention-secret",
        name: "Mention Bot",
        redirect_uris: ["https://example.com/callback"],
        bot_user_id: botUserId,
        scopes: ["app_mentions:read"],
      },
    ],
  });
  return setup;
}

async function call(setup: SlackTestApp, method: string, body: Record<string, unknown>) {
  const response = await setup.app.request(`${base}/api/${method}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as Record<string, any>;
  expect(result.ok).toBe(true);
  return result;
}

describe("Slack app mentions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["mentions", "private-mentions"])(
    "delivers a signed app mention with the posted message's identity in %s",
    async (channelName) => {
      const setup = createMentionTestApp();
      const channel = getSlackStore(setup.store).channels.findOneBy("name", channelName)!.channel_id;
      await call(setup, "conversations.invite", { channel, users: botUserId });
      seedFromConfig(setup.store, base, { signing_secret: "mention-signing-secret" });
      const parent = await call(setup, "chat.postMessage", { channel, text: "Thread parent" });
      const capture = captureFetchRequests();
      registerSlackEventSubscription(setup.webhooks, ["message", "app_mention"]);
      const text = `<@${botUserId}> please investigate`;
      const threadTs = parent.ts;
      const posted = await call(setup, "chat.postMessage", { channel, text, thread_ts: threadTs });

      expect(capture.jsonBodies()).toEqual([
        expect.objectContaining({ event: expect.objectContaining({ type: "message", ts: posted.ts }) }),
        expect.objectContaining({
          type: "event_callback",
          team_id: "T000000001",
          api_app_id: appId,
          authorizations: [expect.objectContaining({ user_id: botUserId, is_bot: true })],
          event_id: expect.stringMatching(/^Ev[0-9a-f]{32}$/),
          event_time: expect.any(Number),
          event: expect.objectContaining({
            type: "app_mention",
            user: "U000000001",
            channel,
            text,
            ts: posted.ts,
            event_ts: posted.ts,
            thread_ts: threadTs,
          }),
        }),
      ]);
      const request = capture.requests[1];
      const headers = request.init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Slack-Signature"]).toBe(
        `v0=${createHmac("sha256", "mention-signing-secret")
          .update(`v0:${headers["X-Slack-Request-Timestamp"]}:${request.init.body}`)
          .digest("hex")}`,
      );
      const replies = await call(setup, "conversations.replies", { channel, ts: threadTs });
      expect(replies.messages).toHaveLength(2);
      expect(replies.messages[1]).toMatchObject({ type: "message", ts: posted.ts, text });
    },
  );

  it("emits once per mentioned App and shares each event across matching subscriptions", async () => {
    const setup = createMentionTestApp();
    const secondBotId = "U_SECOND_BOT";
    seedFromConfig(setup.store, base, {
      oauth_apps: [
        {
          app_id: "A_SECOND_APP",
          client_id: "second-client",
          client_secret: "second-secret",
          name: "Second Bot",
          redirect_uris: ["https://example.com/callback"],
          bot_user_id: secondBotId,
        },
      ],
    });
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "mentions")!.channel_id;
    await call(setup, "conversations.invite", { channel, users: `${botUserId},${secondBotId}` });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);
    setup.webhooks.register({ url: "https://hooks.example/second", events: ["*"], owner: "slack", active: true });
    setup.webhooks.register({
      url: "https://hooks.example/inactive",
      events: ["app_mention"],
      owner: "slack",
      active: false,
    });

    await call(setup, "chat.postMessage", {
      channel,
      text: `<@${botUserId}> <@${botUserId}|mention-bot> and <@${secondBotId}>`,
    });

    const mentions = capture.jsonBodies().filter((body: any) => body.event.type === "app_mention") as Array<{
      api_app_id: string;
      event_id: string;
    }>;
    expect(mentions).toHaveLength(4);
    expect(mentions.map((body) => body.api_app_id)).toEqual([appId, appId, "A_SECOND_APP", "A_SECOND_APP"]);
    expect(mentions[0]).toEqual(mentions[1]);
    expect(mentions[2]).toEqual(mentions[3]);
    expect(mentions[0].event_id).not.toBe(mentions[2].event_id);
    expect(capture.requests.every((request) => request.url !== "https://hooks.example/inactive")).toBe(true);
  });

  it("starts and stops callbacks as the bot joins and leaves a channel", async () => {
    const setup = createMentionTestApp();
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "mentions")!.channel_id;
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);
    const message = { channel, text: `<@${botUserId}> hello` };

    await call(setup, "chat.postMessage", message);
    expect(capture.requests).toHaveLength(0);
    await call(setup, "conversations.invite", { channel, users: botUserId });
    await call(setup, "chat.postMessage", message);
    expect(capture.requests).toHaveLength(1);
    await call(setup, "conversations.kick", { channel, user: botUserId });
    await call(setup, "chat.postMessage", message);
    expect(capture.requests).toHaveLength(1);
  });

  it.each([
    "no mention",
    "mention-bot",
    "<@U000000001>",
    "<@U_UNKNOWN>",
    `<@${botUserId}OTHER>`,
    `&lt;@${botUserId}&gt;`,
  ])("does not emit an app mention for %s", async (text) => {
    const setup = createMentionTestApp();
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "mentions")!.channel_id;
    await call(setup, "conversations.invite", { channel, users: botUserId });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);

    await call(setup, "chat.postMessage", { channel, text });
    expect(capture.requests).toHaveLength(0);
  });

  it.each(["DM", "MPIM", "user ID"])("does not emit app mentions in a %s conversation", async (kind) => {
    const setup = createMentionTestApp();
    const ss = getSlackStore(setup.store);
    const alice = ss.users.findOneBy("name", "alice")!;
    const opened = await call(setup, "conversations.open", {
      users: kind === "MPIM" ? `${botUserId},${alice.user_id}` : botUserId,
    });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);

    await call(setup, "chat.postMessage", {
      channel: kind === "user ID" ? botUserId : opened.channel.id,
      text: `<@${botUserId}> hello`,
    });
    expect(capture.requests).toHaveLength(0);
  });

  it.each(["uninstalled", "other team", "deleted user", "deleted bot"])(
    "does not emit for an unavailable app: %s",
    async (kind) => {
      const setup = createMentionTestApp();
      const ss = getSlackStore(setup.store);
      const channel = ss.channels.findOneBy("name", "mentions")!.channel_id;
      await call(setup, "conversations.invite", { channel, users: botUserId });
      const installation = ss.installations.findOneBy("app_id", appId)!;
      if (kind === "uninstalled") ss.installations.delete(installation.id);
      if (kind === "other team") ss.installations.update(installation.id, { team_id: "T_OTHER" });
      if (kind === "deleted user") ss.users.update(ss.users.findOneBy("user_id", botUserId)!.id, { deleted: true });
      if (kind === "deleted bot")
        ss.bots.update(ss.bots.findOneBy("bot_id", installation.bot_id)!.id, { deleted: true });
      const capture = captureFetchRequests();
      registerSlackEventSubscription(setup.webhooks, ["app_mention"]);

      await call(setup, "chat.postMessage", { channel, text: `<@${botUserId}> hello` });
      expect(capture.requests).toHaveLength(0);
    },
  );

  it("only detects mentions in the stored, truncated message text", async () => {
    const setup = createMentionTestApp();
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "mentions")!.channel_id;
    await call(setup, "conversations.invite", { channel, users: botUserId });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(setup.webhooks, ["app_mention"]);

    const posted = await call(setup, "chat.postMessage", {
      channel,
      text: `${"x".repeat(SLACK_MESSAGE_TEXT_LIMIT)}<@${botUserId}>`,
    });
    expect(posted.warning).toBe("message_truncated");
    expect(capture.requests).toHaveLength(0);
  });
});
