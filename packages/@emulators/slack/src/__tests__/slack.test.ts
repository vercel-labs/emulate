import { describe, it, expect, beforeEach } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { slackPlugin, seedFromConfig, getSlackStore } from "../index.js";
import {
  authHeaders,
  createSlackTestApp as createTestApp,
  slackTestBaseUrl as base,
  type SlackTestApp,
} from "./helpers.js";

describe("Slack plugin - auth.test", () => {
  let app: SlackTestApp["app"];

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("returns user and team info", async () => {
    const res = await app.request(`${base}/api/auth.test`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.user_id).toBe("U000000001");
    expect(body.team).toBeDefined();
  });

  it("returns error without auth", async () => {
    const res = await app.request(`${base}/api/auth.test`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_authed");
  });
});

describe("Slack plugin - chat.postMessage", () => {
  let app: SlackTestApp["app"];
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
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("returns error for missing channel", async () => {
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "nonexistent", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
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
    const parent = (await parentRes.json()) as any;

    // Post reply
    const replyRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reply", thread_ts: parent.ts }),
    });
    const reply = (await replyRes.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message.text).toBe("urlencoded message");
  });

  it("round trips rich JSON message payloads through history", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "*Deploy* completed" } },
      { type: "context", elements: [{ type: "plain_text", text: "production" }] },
    ];
    const attachments = [{ color: "#2eb67d", text: "Release 2026.05.23" }];
    const metadata = { event_type: "deploy_completed", event_payload: { deploy_id: "dep_123" } };

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "deploy completed",
        blocks,
        attachments,
        metadata,
        mrkdwn: false,
        parse: "none",
        link_names: true,
        unfurl_links: false,
        unfurl_media: false,
        username: "Deploy Bot",
        icon_emoji: ":bell:",
        client_msg_id: "client-message-1",
      }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toMatchObject({
      text: "deploy completed",
      blocks,
      attachments,
      metadata,
      mrkdwn: false,
      parse: "none",
      link_names: true,
      unfurl_links: false,
      unfurl_media: false,
      username: "Deploy Bot",
      icon_emoji: ":bell:",
      client_msg_id: "client-message-1",
    });

    const stored = ss.messages.findOneBy("ts", body.ts);
    expect(stored?.blocks).toEqual(blocks);
    expect(stored?.metadata).toEqual(metadata);

    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const history = (await historyRes.json()) as any;
    expect(history.messages[0]).toMatchObject({
      text: "deploy completed",
      blocks,
      attachments,
      metadata,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("parses form-encoded rich message fields", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const blocks = [{ type: "section", text: { type: "plain_text", text: "blocks only" } }];
    const metadata = { event_type: "blocks_only", event_payload: { source: "form" } };
    const form = new URLSearchParams();
    form.set("channel", ch.channel_id);
    form.set("blocks", JSON.stringify(blocks));
    form.set("metadata", JSON.stringify(metadata));
    form.set("unfurl_links", "false");
    form.set("unfurl_media", "0");

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders("application/x-www-form-urlencoded"),
      body: form.toString(),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message.text).toBe("");
    expect(body.message.blocks).toEqual(blocks);
    expect(body.message.metadata).toEqual(metadata);
    expect(body.message.unfurl_links).toBe(false);
    expect(body.message.unfurl_media).toBe(false);
  });

  it("rejects invalid rich payload JSON", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const form = new URLSearchParams();
    form.set("channel", ch.channel_id);
    form.set("blocks", "[");

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders("application/x-www-form-urlencoded"),
      body: form.toString(),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_blocks");
  });
});

describe("Slack plugin - chat.update", () => {
  let app: SlackTestApp["app"];
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
    const posted = (await postRes.json()) as any;

    const updateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts, text: "updated" }),
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.ok).toBe(true);
    expect(updated.text).toBe("updated");
  });

  it("updates rich message fields and returns the full message", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const originalBlocks = [{ type: "section", text: { type: "plain_text", text: "original" } }];
    const updatedBlocks = [{ type: "section", text: { type: "plain_text", text: "updated" } }];
    const updatedAttachments = [{ color: "#36c5f0", text: "updated attachment" }];
    const metadata = { event_type: "message_updated", event_payload: { id: "msg_1" } };

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "original", blocks: originalBlocks }),
    });
    const posted = (await postRes.json()) as any;

    const updateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        ts: posted.ts,
        text: "updated rich",
        blocks: updatedBlocks,
        attachments: updatedAttachments,
        metadata,
        unfurl_links: false,
      }),
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.ok).toBe(true);
    expect(updated.message).toMatchObject({
      text: "updated rich",
      blocks: updatedBlocks,
      attachments: updatedAttachments,
      metadata,
      unfurl_links: false,
    });

    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const history = (await historyRes.json()) as any;
    expect(history.messages[0].blocks).toEqual(updatedBlocks);
    expect(history.messages[0].attachments).toEqual(updatedAttachments);
  });

  it("clears blocks when text is updated without new blocks", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "original",
        blocks: [{ type: "section", text: { type: "plain_text", text: "original" } }],
      }),
    });
    const posted = (await postRes.json()) as any;

    const updateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts, text: "text only" }),
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.ok).toBe(true);
    expect(updated.message.blocks).toBeUndefined();
  });
});

describe("Slack plugin - chat.delete", () => {
  let app: SlackTestApp["app"];
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
    const posted = (await postRes.json()) as any;

    const deleteRes = await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, ts: posted.ts }),
    });
    const deleted = (await deleteRes.json()) as any;
    expect(deleted.ok).toBe(true);
  });
});

describe("Slack plugin - chat.getPermalink", () => {
  let app: SlackTestApp["app"];
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("returns a deterministic permalink for a top-level message", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "link me" }),
    });
    const posted = (await postRes.json()) as any;

    const permalinkRes = await app.request(
      `${base}/api/chat.getPermalink?channel=${ch.channel_id}&message_ts=${posted.ts}`,
      {
        method: "GET",
        headers: authHeaders(),
      },
    );
    const permalink = (await permalinkRes.json()) as any;
    expect(permalink.ok).toBe(true);
    expect(permalink.channel).toBe(ch.channel_id);
    expect(permalink.permalink).toBe(`${base}/archives/${ch.channel_id}/p${posted.ts.replace(".", "")}`);
  });

  it("returns threaded reply permalinks from JSON bodies", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const parentRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "parent" }),
    });
    const parent = (await parentRes.json()) as any;

    const replyRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "reply", thread_ts: parent.ts }),
    });
    const reply = (await replyRes.json()) as any;

    const permalinkRes = await app.request(`${base}/api/chat.getPermalink`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, message_ts: reply.ts }),
    });
    const permalink = (await permalinkRes.json()) as any;
    expect(permalink.ok).toBe(true);
    expect(permalink.permalink).toBe(
      `${base}/archives/${ch.channel_id}/p${reply.ts.replace(".", "")}?thread_ts=${parent.ts}&cid=${ch.channel_id}`,
    );
  });

  it("returns message_not_found for an unknown timestamp", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/chat.getPermalink`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, message_ts: "1234567890.000001" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("message_not_found");
  });
});

describe("Slack plugin - chat.postEphemeral", () => {
  let app: SlackTestApp["app"];
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("stores ephemeral messages outside channel history", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const blocks = [{ type: "section", text: { type: "plain_text", text: "Only you can see this" } }];

    const res = await app.request(`${base}/api/chat.postEphemeral`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, user: "U000000001", blocks }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message_ts).toBeDefined();

    const ephemeral = ss.ephemeralMessages.findOneBy("ts", body.message_ts);
    expect(ephemeral?.target_user).toBe("U000000001");
    expect(ephemeral?.blocks).toEqual(blocks);

    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const history = (await historyRes.json()) as any;
    expect(history.messages).toEqual([]);
  });

  it("accepts channel membership stored by seeded login name", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    ss.channels.update(ch.id, { members: ["admin"], num_members: 1 });

    const res = await app.request(`${base}/api/chat.postEphemeral`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, user: "U000000001", text: "private" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message_ts).toBeDefined();
  });

  it("returns user_not_in_channel for a target outside the channel", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    ss.users.insert({
      user_id: "U000000999",
      team_id: "T000000001",
      name: "outsider",
      real_name: "Outsider",
      email: "outsider@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "outsider",
        real_name: "Outsider",
        email: "outsider@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });

    const res = await app.request(`${base}/api/chat.postEphemeral`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, user: "U000000999", text: "private" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("user_not_in_channel");
  });
});

describe("Slack plugin - scheduled messages", () => {
  let app: SlackTestApp["app"];
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("schedules, lists, and deletes a message", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const postAt = Math.floor(Date.now() / 1000) + 3600;
    const blocks = [{ type: "section", text: { type: "plain_text", text: "Scheduled block" } }];

    const scheduleRes = await app.request(`${base}/api/chat.scheduleMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "scheduled message",
        blocks,
        post_at: postAt,
      }),
    });
    const scheduled = (await scheduleRes.json()) as any;
    expect(scheduled.ok).toBe(true);
    expect(scheduled.channel).toBe(ch.channel_id);
    expect(scheduled.scheduled_message_id).toMatch(/^Q/);
    expect(scheduled.post_at).toBe(postAt);
    expect(scheduled.message).toMatchObject({
      type: "delayed_message",
      subtype: "bot_message",
      text: "scheduled message",
      blocks,
    });

    const listRes = await app.request(`${base}/api/chat.scheduledMessages.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const list = (await listRes.json()) as any;
    expect(list.ok).toBe(true);
    expect(list.scheduled_messages).toEqual([
      expect.objectContaining({
        id: scheduled.scheduled_message_id,
        channel_id: ch.channel_id,
        post_at: postAt,
        text: "scheduled message",
      }),
    ]);

    const deleteRes = await app.request(`${base}/api/chat.deleteScheduledMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, scheduled_message_id: scheduled.scheduled_message_id }),
    });
    expect(((await deleteRes.json()) as any).ok).toBe(true);
    expect(ss.scheduledMessages.all()).toEqual([]);
  });

  it("returns time_in_past for past scheduled messages", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/chat.scheduleMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "too late",
        post_at: Math.floor(Date.now() / 1000) - 1,
      }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("time_in_past");
  });

  it("returns invalid_arguments for nonpositive scheduled list limits", async () => {
    const res = await app.request(`${base}/api/chat.scheduledMessages.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ limit: -1 }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_arguments");
  });

  it("returns invalid_arguments for invalid scheduled list time filters", async () => {
    const res = await app.request(`${base}/api/chat.scheduledMessages.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ oldest: "not-a-time" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_arguments");
  });

  it("returns invalid_cursor for unknown scheduled message list cursors", async () => {
    const res = await app.request(`${base}/api/chat.scheduledMessages.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ cursor: "Q000000999" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_cursor");
  });

  it("returns invalid_scheduled_message_id for unknown scheduled messages", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const res = await app.request(`${base}/api/chat.deleteScheduledMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, scheduled_message_id: "Q000000999" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_scheduled_message_id");
  });
});

describe("Slack plugin - conversations", () => {
  let app: SlackTestApp["app"];
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
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("name_taken");
  });

  it("archives and unarchives a channel", async () => {
    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "archive-test" }),
    });
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    const archiveRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    expect(((await archiveRes.json()) as any).ok).toBe(true);

    const archivedInfoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const archivedInfo = (await archivedInfoRes.json()) as any;
    expect(archivedInfo.channel.is_archived).toBe(true);

    const listRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
    });
    const list = (await listRes.json()) as any;
    expect(list.channels.map((channel: any) => channel.id)).toContain(channelId);
    expect(list.channels.find((channel: any) => channel.id === channelId).is_archived).toBe(true);

    const excludeArchivedListRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ exclude_archived: true }),
    });
    const excludeArchivedList = (await excludeArchivedListRes.json()) as any;
    expect(excludeArchivedList.channels.map((channel: any) => channel.id)).not.toContain(channelId);

    const duplicateArchiveRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const duplicateArchive = (await duplicateArchiveRes.json()) as any;
    expect(duplicateArchive.ok).toBe(false);
    expect(duplicateArchive.error).toBe("already_archived");

    const unarchiveRes = await app.request(`${base}/api/conversations.unarchive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    expect(((await unarchiveRes.json()) as any).ok).toBe(true);

    const unarchivedInfoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const unarchivedInfo = (await unarchivedInfoRes.json()) as any;
    expect(unarchivedInfo.channel.is_archived).toBe(false);
  });

  it("rejects archiving general and unarchiving active channels", async () => {
    const ss = getSlackStore(store);
    const general = ss.channels.findOneBy("name", "general")!;
    const random = ss.channels.findOneBy("name", "random")!;

    const archiveGeneralRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: general.channel_id }),
    });
    const archiveGeneral = (await archiveGeneralRes.json()) as any;
    expect(archiveGeneral.ok).toBe(false);
    expect(archiveGeneral.error).toBe("cant_archive_general");

    await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: general.channel_id, name: "renamed-general" }),
    });

    const archiveRenamedGeneralRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: general.channel_id }),
    });
    const archiveRenamedGeneral = (await archiveRenamedGeneralRes.json()) as any;
    expect(archiveRenamedGeneral.ok).toBe(false);
    expect(archiveRenamedGeneral.error).toBe("cant_archive_general");

    const unarchiveActiveRes = await app.request(`${base}/api/conversations.unarchive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id }),
    });
    const unarchiveActive = (await unarchiveActiveRes.json()) as any;
    expect(unarchiveActive.ok).toBe(false);
    expect(unarchiveActive.error).toBe("not_archived");
  });

  it("renames a channel and rejects invalid rename requests", async () => {
    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "rename-test" }),
    });
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    const renameRes = await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, name: "Renamed Test" }),
    });
    const renamed = (await renameRes.json()) as any;
    expect(renamed.ok).toBe(true);
    expect(renamed.channel.name).toBe("renamed-test");

    const infoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.channel.name).toBe("renamed-test");

    const duplicateRes = await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, name: "general" }),
    });
    const duplicate = (await duplicateRes.json()) as any;
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toBe("name_taken");

    const invalidRes = await app.request(`${base}/api/conversations.rename`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, name: "bad!" }),
    });
    const invalid = (await invalidRes.json()) as any;
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toBe("invalid_name_specials");
  });

  it("sets conversation topic and purpose", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.findOneBy("name", "random")!;

    const topicRes = await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, topic: "Release coordination" }),
    });
    const topic = (await topicRes.json()) as any;
    expect(topic.ok).toBe(true);
    expect(topic.channel.topic).toMatchObject({
      value: "Release coordination",
      creator: "U000000001",
    });

    const purposeRes = await app.request(`${base}/api/conversations.setPurpose`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, purpose: "Coordinate release work" }),
    });
    const purpose = (await purposeRes.json()) as any;
    expect(purpose.ok).toBe(true);
    expect(purpose.purpose).toBe("Coordinate release work");
    expect(purpose.channel.purpose).toMatchObject({
      value: "Coordinate release work",
      creator: "U000000001",
    });

    const infoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.channel.topic.value).toBe("Release coordination");
    expect(info.channel.purpose.value).toBe("Coordinate release work");
  });

  it("rejects topic and purpose updates for invalid lifecycle states", async () => {
    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "lifecycle-state-test" }),
    });
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });

    const topicRes = await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, topic: "no access" }),
    });
    const topic = (await topicRes.json()) as any;
    expect(topic.ok).toBe(false);
    expect(topic.error).toBe("not_in_channel");

    await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });

    const archivedPurposeRes = await app.request(`${base}/api/conversations.setPurpose`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, purpose: "archived" }),
    });
    const archivedPurpose = (await archivedPurposeRes.json()) as any;
    expect(archivedPurpose.ok).toBe(false);
    expect(archivedPurpose.error).toBe("is_archived");

    const longTopicRes = await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "C000000001", topic: "x".repeat(251) }),
    });
    const longTopic = (await longTopicRes.json()) as any;
    expect(longTopic.ok).toBe(false);
    expect(longTopic.error).toBe("too_long");
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
    const body = (await res.json()) as any;
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
    const parent = (await parentRes.json()) as any;

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
    const body = (await res.json()) as any;
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
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    // Leave
    const leaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    expect(((await leaveRes.json()) as any).ok).toBe(true);

    // Rejoin
    const joinRes = await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const joined = (await joinRes.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.members.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Slack plugin - users", () => {
  let app: SlackTestApp["app"];

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists users", async () => {
    const res = await app.request(`${base}/api/users.list`, {
      method: "POST",
      headers: authHeaders(),
    });
    const body = (await res.json()) as any;
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
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("U000000001");
  });

  it("looks up user by email", async () => {
    const res = await app.request(`${base}/api/users.lookupByEmail`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: "admin@emulate.dev" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.user.profile.email).toBe("admin@emulate.dev");
  });

  it("returns error for unknown user", async () => {
    const res = await app.request(`${base}/api/users.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user: "U999999999" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("user_not_found");
  });
});

describe("Slack plugin - reactions", () => {
  let app: SlackTestApp["app"];
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
    const posted = (await postRes.json()) as any;

    // Add reaction
    const addRes = await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "thumbsup" }),
    });
    expect(((await addRes.json()) as any).ok).toBe(true);

    // Get reactions
    const getRes = await app.request(`${base}/api/reactions.get`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });
    const body = (await getRes.json()) as any;
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
    const posted = (await postRes.json()) as any;

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
    expect(((await removeRes.json()) as any).ok).toBe(true);

    // Verify removed
    const getRes = await app.request(`${base}/api/reactions.get`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });
    const body = (await getRes.json()) as any;
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
    const posted = (await postRes.json()) as any;

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
    const dupe = (await dupeRes.json()) as any;
    expect(dupe.ok).toBe(false);
    expect(dupe.error).toBe("already_reacted");
  });
});

describe("Slack plugin - team.info", () => {
  let app: SlackTestApp["app"];

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("returns team info", async () => {
    const res = await app.request(`${base}/api/team.info`, {
      method: "POST",
      headers: authHeaders(),
    });
    const body = (await res.json()) as any;
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
    slackPlugin.register!(app as any, store, webhooks, base);
    slackPlugin.seed?.(store, base);

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
  let app: SlackTestApp["app"];

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
      `${base}/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to Slack");
    expect(html).toContain("Test App");
    expect(html).toContain("Slack Emulator");
  });

  it("rejects unknown client_id", async () => {
    const res = await app.request(
      `${base}/oauth/v2/authorize?client_id=invalid&redirect_uri=http://localhost:3000/callback`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Application not found");
  });

  it("completes the token exchange", async () => {
    // Get the consent page to verify it loads
    const authRes = await app.request(
      `${base}/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write&state=xyz`,
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
    const token = (await tokenRes.json()) as any;
    expect(token.ok).toBe(true);
    expect(token.access_token).toMatch(/^xoxb-/);
    expect(token.team.name).toBe("Emulate");
    expect(token.authed_user.id).toBe("U000000001");
  });
});

describe("Slack plugin - Incoming Webhooks", () => {
  let app: SlackTestApp["app"];
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

  it("preserves rich payloads from incoming webhooks", async () => {
    const ss = getSlackStore(store);
    const webhook = ss.incomingWebhooks.all()[0];
    const blocks = [{ type: "section", text: { type: "plain_text", text: "Webhook block" } }];
    const attachments = [{ color: "#e01e5a", text: "Webhook attachment" }];

    const res = await app.request(`${base}${webhook.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks, attachments, unfurl_links: false }),
    });
    expect(res.status).toBe(200);

    const messages = ss.messages.findBy("channel_id", "C000000001");
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe("");
    expect(messages[0].blocks).toEqual(blocks);
    expect(messages[0].attachments).toEqual(attachments);
    expect(messages[0].unfurl_links).toBe(false);
    expect(messages[0].bot_id).toBe(webhook.bot_id);
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
  let app: SlackTestApp["app"];
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

  it("shows rich messages with no text in the inspector", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        blocks: [{ type: "section", text: { type: "plain_text", text: "Inspector rich block" } }],
      }),
    });

    const res = await app.request(`${base}/?channel=${ch.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Inspector rich block");
    expect(html).toContain('badge badge-granted">rich');
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
