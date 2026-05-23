import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
} from "./helpers.js";

describe("Slack plugin - event dispatch baseline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches message events for chat.postMessage", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    const ch = getSlackStore(store).channels.findOneBy("name", "general")!;
    const blocks = [{ type: "section", text: { type: "plain_text", text: "event baseline" } }];
    const metadata = { event_type: "message_posted", event_payload: { id: "event_1" } };
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "event baseline", blocks, metadata }),
    });
    expect(res.status).toBe(200);

    expect(capture.requests).toHaveLength(1);
    expect(capture.jsonBodies()[0]).toMatchObject({
      type: "event_callback",
      event: {
        type: "message",
        channel: ch.channel_id,
        user: "U000000001",
        text: "event baseline",
        blocks,
        metadata,
      },
    });
  });

  it("dispatches reaction add and remove events", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["reaction_added", "reaction_removed"]);

    const ch = getSlackStore(store).channels.findOneBy("name", "general")!;
    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reaction event baseline" }),
    });
    const posted = (await postRes.json()) as { ts: string };

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "white_check_mark" }),
    });

    await app.request(`${base}/api/reactions.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "white_check_mark" }),
    });

    expect(capture.requests).toHaveLength(2);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "reaction_added",
          reaction: "white_check_mark",
          item: { type: "message", channel: ch.channel_id, ts: posted.ts },
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "reaction_removed",
          reaction: "white_check_mark",
          item: { type: "message", channel: ch.channel_id, ts: posted.ts },
        }),
      }),
    ]);
  });

  it("dispatches message_changed events for chat.update", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    const ch = getSlackStore(store).channels.findOneBy("name", "general")!;
    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "before update" }),
    });
    const posted = (await postRes.json()) as { ts: string };

    await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts, text: "after update" }),
    });

    expect(capture.requests).toHaveLength(2);
    const event = capture.jsonBodies()[1] as any;
    expect(event).toMatchObject({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        hidden: true,
        channel: ch.channel_id,
        message: {
          type: "message",
          user: "U000000001",
          text: "after update",
          ts: posted.ts,
          edited: { user: "U000000001" },
        },
        previous_message: {
          type: "message",
          user: "U000000001",
          text: "before update",
          ts: posted.ts,
        },
      },
    });
    expect(event.event.ts).not.toBe(posted.ts);
    expect(event.event.event_ts).toBe(event.event.ts);
    expect(event.event.message.edited.ts).toBe(event.event.ts);
  });

  it("dispatches message_deleted events for chat.delete", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    const ch = getSlackStore(store).channels.findOneBy("name", "general")!;
    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "delete event baseline" }),
    });
    const posted = (await postRes.json()) as { ts: string };

    await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts }),
    });

    expect(capture.requests).toHaveLength(2);
    const event = capture.jsonBodies()[1] as any;
    expect(event).toMatchObject({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_deleted",
        hidden: true,
        channel: ch.channel_id,
        deleted_ts: posted.ts,
        previous_message: {
          type: "message",
          user: "U000000001",
          text: "delete event baseline",
          ts: posted.ts,
        },
      },
    });
    expect(event.event.ts).not.toBe(posted.ts);
    expect(event.event.event_ts).toBe(event.event.ts);
  });

  it("dispatches bot message events for incoming webhooks", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0]!;
    const res = await app.request(`${base}${webhook.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "webhook event baseline" }),
    });
    expect(res.status).toBe(200);

    expect(capture.requests).toHaveLength(1);
    expect(capture.jsonBodies()[0]).toMatchObject({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "bot_message",
        bot_id: webhook.bot_id,
        text: "webhook event baseline",
      },
    });
    expect((capture.jsonBodies()[0] as any).event.user).toBeUndefined();
  });

  it("dispatches archive and unarchive lifecycle events", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["channel_archive", "channel_unarchive", "message"]);

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "event-archive-test" }),
    });
    const created = (await createRes.json()) as any;
    const channel = created.channel.id;

    await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    await app.request(`${base}/api/conversations.unarchive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });

    expect(capture.requests).toHaveLength(4);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "channel_archive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "channel_archive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "channel_unarchive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "channel_unarchive",
          channel,
          user: "U000000001",
        }),
      }),
    ]);
  });

  it("dispatches private archive and unarchive lifecycle events as group events", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["group_archive", "group_unarchive", "message"]);

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "event-private-archive-test", is_private: true }),
    });
    const created = (await createRes.json()) as any;
    const channel = created.channel.id;

    await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    await app.request(`${base}/api/conversations.unarchive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });

    expect(capture.requests).toHaveLength(4);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "group_archive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "group_archive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "group_unarchive",
          channel,
          user: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "group_unarchive",
          channel,
          user: "U000000001",
        }),
      }),
    ]);
  });

  it("dispatches rename, topic, and purpose lifecycle events", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["channel_rename", "message"]);

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "event-lifecycle-test" }),
    });
    const created = (await createRes.json()) as any;
    const channel = created.channel.id;

    await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, name: "event-renamed-test" }),
    });
    await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, topic: "Event topic" }),
    });
    await app.request(`${base}/api/conversations.setPurpose`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, purpose: "Event purpose" }),
    });

    expect(capture.requests).toHaveLength(4);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "channel_rename",
          channel: expect.objectContaining({
            id: channel,
            name: "event-renamed-test",
          }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "channel_name",
          channel,
          old_name: "event-lifecycle-test",
          name: "event-renamed-test",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "channel_topic",
          channel,
          topic: "Event topic",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "channel_purpose",
          channel,
          purpose: "Event purpose",
        }),
      }),
    ]);
  });

  it("dispatches private rename, topic, and purpose lifecycle events as group events", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["group_rename", "message"]);

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "event-private-lifecycle-test", is_private: true }),
    });
    const created = (await createRes.json()) as any;
    const channel = created.channel.id;

    await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, name: "event-private-renamed-test" }),
    });
    await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, topic: "Private event topic" }),
    });
    await app.request(`${base}/api/conversations.setPurpose`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, purpose: "Private event purpose" }),
    });

    expect(capture.requests).toHaveLength(4);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "group_rename",
          channel: expect.objectContaining({
            id: channel,
            name: "event-private-renamed-test",
          }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "group_name",
          channel,
          old_name: "event-private-lifecycle-test",
          name: "event-private-renamed-test",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "group_topic",
          channel,
          topic: "Private event topic",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "group_purpose",
          channel,
          purpose: "Private event purpose",
        }),
      }),
    ]);
  });
});
