import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore } from "../index.js";
import { SLACK_MESSAGE_TEXT_LIMIT } from "../helpers.js";
import {
  authHeaders,
  captureFetchRequests as captureRawFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
} from "./helpers.js";

function captureFetchRequests(teamId = "T000000001") {
  const capture = captureRawFetchRequests();
  return {
    ...capture,
    jsonBodies: () => {
      const bodies = capture.jsonBodies();
      for (const body of bodies) {
        expect(body).toMatchObject({ type: "event_callback", team_id: teamId, event: expect.any(Object) });
        const envelope = body as { event_id: string; event_time: number };
        expect(envelope.event_id).toMatch(/^Ev[0-9a-f]{32}$/);
        expect(Number.isInteger(envelope.event_time)).toBe(true);
        expect(envelope.event_time).toBeGreaterThan(0);
      }
      return bodies;
    },
  };
}

describe("Slack plugin - event dispatch baseline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["TokenMap-only", "seeded token"])(
    "uses complete envelopes for five mutation routes with %s auth",
    async (authMode) => {
      const { app, store, webhooks } = createSlackTestApp();
      const teamId = authMode === "seeded token" ? "TOTHERTEAM" : "T000000001";
      const token = authMode === "seeded token" ? "xoxb-events-team" : "xoxb-test-token";
      if (authMode === "seeded token") {
        getSlackStore(store).tokens.insert({
          token,
          token_type: "bot",
          team_id: teamId,
          user_id: "U000000001",
          scopes: ["chat:write", "reactions:write"],
        });
      }
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const capture = captureFetchRequests(teamId);
      registerSlackEventSubscription(webhooks, ["message", "reaction_added", "reaction_removed"]);
      const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
      vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_123);

      const postRes = await app.request(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ channel, text: "envelope repro" }),
      });
      const posted = (await postRes.json()) as { ok: boolean; ts: string };
      expect(posted.ok).toBe(true);

      for (const [method, body] of [
        ["chat.update", { channel, ts: posted.ts, text: "updated envelope" }],
        ["reactions.add", { channel, timestamp: posted.ts, name: "eyes" }],
        ["reactions.remove", { channel, timestamp: posted.ts, name: "eyes" }],
        ["chat.delete", { channel, ts: posted.ts }],
      ] as const) {
        const response = await app.request(`${base}/api/${method}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
      }

      const bodies = capture.jsonBodies() as Array<{
        event_id: string;
        event_time: number;
        event: { type: string; subtype?: string; item?: { channel: string; ts: string } };
      }>;
      expect(bodies).toHaveLength(5);
      expect(bodies.map((body) => [body.event.type, body.event.subtype])).toEqual([
        ["message", undefined],
        ["message", "message_changed"],
        ["reaction_added", undefined],
        ["reaction_removed", undefined],
        ["message", "message_deleted"],
      ]);
      expect(bodies[2].event.item).toEqual({ type: "message", channel, ts: posted.ts });
      expect(bodies[3].event.item).toEqual({ type: "message", channel, ts: posted.ts });
      expect(bodies.map((body) => body.event_time)).toEqual(Array(5).fill(1_750_000_000));
      expect(new Set(bodies.map((body) => body.event_id)).size).toBe(5);

      const rejected = await app.request(`${base}/api/reactions.remove`, {
        method: "POST",
        headers,
        body: JSON.stringify({ channel, timestamp: posted.ts, name: "eyes" }),
      });
      expect((await rejected.json()) as { error: string }).toMatchObject({ error: "message_not_found" });
      const invalidPost = await app.request(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ channel, text: "" }),
      });
      expect((await invalidPost.json()) as { error: string }).toMatchObject({ error: "no_text" });
      expect(capture.requests).toHaveLength(5);
    },
  );

  it("selects the team from the presented token when two installations share a user", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const slackStore = getSlackStore(store);
    const teams = ["TINSTALLA", "TINSTALLB"];
    for (const [index, teamId] of teams.entries()) {
      slackStore.tokens.insert({
        token: `xoxb-install-${index}`,
        token_type: "bot",
        team_id: teamId,
        user_id: "U000000001",
        scopes: ["chat:write"],
      });
    }
    const capture = captureRawFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);
    const channel = slackStore.channels.findOneBy("name", "general")!.channel_id;

    for (const [index] of teams.entries()) {
      const response = await app.request(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: { Authorization: `Bearer xoxb-install-${index}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text: `installation ${index}` }),
      });
      expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
    }

    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({ team_id: teams[0], event_id: expect.any(String), event_time: expect.any(Number) }),
      expect.objectContaining({ team_id: teams[1], event_id: expect.any(String), event_time: expect.any(Number) }),
    ]);
  });

  it("falls back to the affected channel for development tokens and unmatched incoming webhooks", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const slackStore = getSlackStore(store);
    const channel = slackStore.channels.findOneBy("name", "general")!;
    slackStore.channels.update(channel.id, { team_id: "TCHANNELOTHER" });
    const capture = captureFetchRequests("TCHANNELOTHER");
    registerSlackEventSubscription(webhooks, ["message"]);

    const posted = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channel.channel_id, text: "channel team fallback" }),
    });
    expect((await posted.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const incoming = await app.request(`${base}/services/TIGNORED/BUNKNOWN/XUNKNOWN`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel.channel_id, text: "unregistered webhook fallback" }),
    });
    expect(incoming.status).toBe(200);
    expect(capture.jsonBodies()).toHaveLength(2);
  });

  it("falls back to the affected user's team for development tokens", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const slackStore = getSlackStore(store);
    const user = slackStore.users.findOneBy("user_id", "U000000001")!;
    slackStore.users.update(user.id, { team_id: "TUSEROTHER" });
    const capture = captureFetchRequests("TUSEROTHER");
    registerSlackEventSubscription(webhooks, ["user_change"]);

    const response = await app.request(`${base}/api/users.profile.set`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ profile: { display_name: "Other team user" } }),
    });
    expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(capture.jsonBodies()).toHaveLength(1);
  });

  it("shares one envelope across subscriptions without reusing it for later events", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);
    webhooks.register({ url: "https://hooks.example/second", events: ["message"], active: true, owner: "slack" });
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;

    for (const text of ["first", "second"]) {
      const response = await app.request(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ channel, text }),
      });
      expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
    }

    const bodies = capture.jsonBodies() as Array<{ event_id: string; event_time: number }>;
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2]).toEqual(bodies[3]);
    expect(bodies[0].event_id).not.toBe(bodies[2].event_id);
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

  it("dispatches the normalized text for over-limit posts and updates", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const normalized = "x".repeat(SLACK_MESSAGE_TEXT_LIMIT);

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: `${normalized}tail` }),
    });
    const posted = (await postRes.json()) as any;
    await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, ts: posted.ts, text: `${normalized}updated` }),
    });

    const bodies = capture.jsonBodies() as any[];
    expect(bodies[0].event.text).toBe(normalized);
    expect(bodies[1].event.message.text).toBe(normalized);
    expect(bodies[1].event.previous_message.text).toBe(normalized);
  });

  it("dispatches IM lifecycle events when chat.postMessage creates a DM by user id", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["im_created", "im_open", "message"]);

    getSlackStore(store).users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "events-post-dm",
      real_name: "events-post-dm",
      email: "events-post-dm@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "events-post-dm",
        real_name: "events-post-dm",
        email: "events-post-dm@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "U000000002", text: "DM event from postMessage" }),
    });
    const posted = (await postRes.json()) as any;

    expect(capture.requests).toHaveLength(3);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "im_created",
          channel: expect.objectContaining({ id: posted.channel, is_im: true, user: "U000000002" }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: "im_open", channel: posted.channel }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          channel: posted.channel,
          user: "U000000001",
          text: "DM event from postMessage",
        }),
      }),
    ]);
  });

  it("dispatches IM open when chat.postMessage reopens a closed DM by user id", async () => {
    const { app, store, webhooks } = createSlackTestApp();

    getSlackStore(store).users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "events-reopen-dm",
      real_name: "events-reopen-dm",
      email: "events-reopen-dm@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "events-reopen-dm",
        real_name: "events-reopen-dm",
        email: "events-reopen-dm@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002" }),
    });
    const opened = (await openRes.json()) as any;
    await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id }),
    });

    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["im_open", "message"]);

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "U000000002", text: "reopened DM event" }),
    });
    const posted = (await postRes.json()) as any;

    expect(capture.requests).toHaveLength(2);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: "im_open", channel: opened.channel.id }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          channel: opened.channel.id,
          text: "reopened DM event",
        }),
      }),
    ]);
    expect(posted.channel).toBe(opened.channel.id);
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

  it("dispatches pin add and remove events", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["pin_added", "pin_removed"]);

    const ch = getSlackStore(store).channels.findOneBy("name", "general")!;
    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "pin event baseline" }),
    });
    const posted = (await postRes.json()) as { ts: string };

    await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });

    await app.request(`${base}/api/pins.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });

    expect(capture.requests).toHaveLength(2);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "pin_added",
          user: "U000000001",
          channel_id: ch.channel_id,
          item: expect.objectContaining({
            type: "message",
            channel: ch.channel_id,
            message: expect.objectContaining({ text: "pin event baseline", pinned_to: [ch.channel_id] }),
          }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "pin_removed",
          user: "U000000001",
          channel_id: ch.channel_id,
          has_pins: false,
          item: expect.objectContaining({
            type: "message",
            channel: ch.channel_id,
          }),
        }),
      }),
    ]);
  });

  it("dispatches user_change events for profile writes", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["user_change"]);

    const res = await app.request(`${base}/api/users.profile.set`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user: "U000000001",
        profile: { display_name: "Events Admin", status_text: "Reviewing events" },
      }),
    });
    expect(res.status).toBe(200);

    expect(capture.requests).toHaveLength(1);
    expect(capture.jsonBodies()[0]).toMatchObject({
      type: "event_callback",
      event: {
        type: "user_change",
        user: {
          id: "U000000001",
          profile: {
            display_name: "Events Admin",
            status_text: "Reviewing events",
          },
        },
      },
    });
  });

  it("dispatches presence_change events for presence writes", async () => {
    const { app, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["presence_change"]);

    const res = await app.request(`${base}/api/users.setPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ presence: "away" }),
    });
    expect(res.status).toBe(200);

    expect(capture.requests).toHaveLength(1);
    expect(capture.jsonBodies()[0]).toMatchObject({
      type: "event_callback",
      event: {
        type: "presence_change",
        user: "U000000001",
        presence: "away",
      },
    });
  });

  it("dispatches file upload and file share events", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["file_created", "file_shared", "file_deleted", "message"]);

    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "events.txt", length: 12 }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "event file" });

    await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "Event File" }],
        channel_id: channel,
        initial_comment: "File event",
      }),
    });

    expect(capture.requests).toHaveLength(3);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "file_created",
          file_id: upload.file_id,
          file: expect.objectContaining({ id: upload.file_id, title: "Event File" }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "file_shared",
          file_id: upload.file_id,
          channel_id: channel,
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "message",
          subtype: "file_share",
          channel,
          text: "File event",
          files: [expect.objectContaining({ id: upload.file_id })],
        }),
      }),
    ]);
    const deleted = await app.request(`${base}/api/files.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ file: upload.file_id }),
    });
    expect((await deleted.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(capture.jsonBodies()[3]).toMatchObject({
      event: { type: "file_deleted", file_id: upload.file_id },
    });
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
    const capture = captureFetchRequests("TWEBHOOKOTHER");
    registerSlackEventSubscription(webhooks, ["message"]);

    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0]!;
    ss.incomingWebhooks.update(webhook.id, { team_id: "TWEBHOOKOTHER" });
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

  it("dispatches member join and leave events for invite and kick", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["member_joined_channel", "member_left_channel"]);

    getSlackStore(store).users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "events-member",
      real_name: "events-member",
      email: "events-member@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "events-member",
        real_name: "events-member",
        email: "events-member@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });
    const channel = getSlackStore(store).channels.findOneBy("name", "random")!.channel_id;

    await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, users: "U000000002" }),
    });
    await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, user: "U000000002" }),
    });

    expect(capture.requests).toHaveLength(2);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "member_joined_channel",
          user: "U000000002",
          channel,
          channel_type: "C",
          team: "T000000001",
          inviter: "U000000001",
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          type: "member_left_channel",
          user: "U000000002",
          channel,
          channel_type: "C",
          team: "T000000001",
        }),
      }),
    ]);
  });

  it("dispatches IM open, close, and mark events", async () => {
    const { app, store, webhooks } = createSlackTestApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["im_created", "im_open", "im_close", "im_marked"]);

    getSlackStore(store).users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "events-dm",
      real_name: "events-dm",
      email: "events-dm@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "events-dm",
        real_name: "events-dm",
        email: "events-dm@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002" }),
    });
    const opened = (await openRes.json()) as any;
    const channel = opened.channel.id;

    await app.request(`${base}/api/conversations.mark`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, ts: "1234567890.000001" }),
    });
    await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });

    expect(capture.requests).toHaveLength(4);
    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "im_created",
          channel: expect.objectContaining({ id: channel, is_im: true }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: "im_open", channel }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: "im_marked", channel, ts: "1234567890.000001" }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: "im_close", channel }),
      }),
    ]);
  });
});
