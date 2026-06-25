import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { slackPlugin, seedFromConfig, getSlackStore } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp as createTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  type SlackTestApp,
} from "./helpers.js";

function insertSlackTestUser(store: Store, userId: string, name: string) {
  return getSlackStore(store).users.insert({
    user_id: userId,
    team_id: "T000000001",
    name,
    real_name: name,
    email: `${name}@emulate.dev`,
    is_admin: false,
    is_bot: false,
    deleted: false,
    profile: {
      display_name: name,
      real_name: name,
      email: `${name}@emulate.dev`,
      image_48: "",
      image_192: "",
    },
  });
}

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

  it("rejects message block payloads over Slack limits", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const tooManyBlocks = Array.from({ length: 51 }, (_, index) => ({
      type: "section",
      text: { type: "plain_text", text: `block ${index}` },
    }));
    const tooManyBlocksRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "too many blocks", blocks: tooManyBlocks }),
    });
    const tooManyBlocksBody = (await tooManyBlocksRes.json()) as any;
    expect(tooManyBlocksBody.ok).toBe(false);
    expect(tooManyBlocksBody.error).toBe("msg_blocks_too_long");

    const oversizedSectionRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "oversized section",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "x".repeat(3_001) } }],
      }),
    });
    const oversizedSectionBody = (await oversizedSectionRes.json()) as any;
    expect(oversizedSectionBody.ok).toBe(false);
    expect(oversizedSectionBody.error).toBe("msg_blocks_too_long");
  });
});

describe("Slack plugin - chat.update", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("rejects private updates by non-members and public updates by non-authors", async () => {
    insertSlackTestUser(store, "U000000002", "update-outsider");
    tokenMap.set("xoxb-update-outsider-token", { login: "U000000002", id: 2, scopes: ["chat:write"] });
    const outsiderHeaders = {
      Authorization: "Bearer xoxb-update-outsider-token",
      "Content-Type": "application/json",
    };

    const privateCreateRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "update-private-authz", is_private: true }),
    });
    const privateChannel = ((await privateCreateRes.json()) as any).channel.id;

    const privatePostRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: privateChannel, text: "private original" }),
    });
    const privatePost = (await privatePostRes.json()) as any;

    const privateUpdateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: privateChannel, ts: privatePost.ts, text: "private changed" }),
    });
    const privateUpdate = (await privateUpdateRes.json()) as any;
    expect(privateUpdate.ok).toBe(false);
    expect(privateUpdate.error).toBe("not_in_channel");

    const publicPostRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "C000000001", text: "public original" }),
    });
    const publicPost = (await publicPostRes.json()) as any;

    const publicUpdateRes = await app.request(`${base}/api/chat.update`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: "C000000001", ts: publicPost.ts, text: "public changed" }),
    });
    const publicUpdate = (await publicUpdateRes.json()) as any;
    expect(publicUpdate.ok).toBe(false);
    expect(publicUpdate.error).toBe("cant_update_message");
  });
});

describe("Slack plugin - chat.delete", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("rejects private deletes by non-members and public deletes by non-authors", async () => {
    insertSlackTestUser(store, "U000000002", "delete-outsider");
    tokenMap.set("xoxb-delete-outsider-token", { login: "U000000002", id: 2, scopes: ["chat:write"] });
    const outsiderHeaders = {
      Authorization: "Bearer xoxb-delete-outsider-token",
      "Content-Type": "application/json",
    };

    const privateCreateRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "delete-private-authz", is_private: true }),
    });
    const privateChannel = ((await privateCreateRes.json()) as any).channel.id;

    const privatePostRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: privateChannel, text: "private delete original" }),
    });
    const privatePost = (await privatePostRes.json()) as any;

    const privateDeleteRes = await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: privateChannel, ts: privatePost.ts }),
    });
    const privateDelete = (await privateDeleteRes.json()) as any;
    expect(privateDelete.ok).toBe(false);
    expect(privateDelete.error).toBe("not_in_channel");

    const publicPostRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "C000000001", text: "public delete original" }),
    });
    const publicPost = (await publicPostRes.json()) as any;

    const publicDeleteRes = await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: "C000000001", ts: publicPost.ts }),
    });
    const publicDelete = (await publicDeleteRes.json()) as any;
    expect(publicDelete.ok).toBe(false);
    expect(publicDelete.error).toBe("cant_delete_message");
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
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("scopes scheduled message list and delete to the author", async () => {
    insertSlackTestUser(store, "U000000002", "scheduled-peer");
    tokenMap.set("xoxb-scheduled-peer-token", { login: "U000000002", id: 2, scopes: ["chat:write"] });
    const peerHeaders = { Authorization: "Bearer xoxb-scheduled-peer-token", "Content-Type": "application/json" };
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const postAt = Math.floor(Date.now() / 1000) + 3600;

    const scheduleRes = await app.request(`${base}/api/chat.scheduleMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: ch.channel_id,
        text: "admin scheduled message",
        post_at: postAt,
      }),
    });
    const scheduled = (await scheduleRes.json()) as any;
    expect(scheduled.ok).toBe(true);

    const peerListRes = await app.request(`${base}/api/chat.scheduledMessages.list`, {
      method: "POST",
      headers: peerHeaders,
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const peerList = (await peerListRes.json()) as any;
    expect(peerList.ok).toBe(true);
    expect(peerList.scheduled_messages).toEqual([]);

    const peerDeleteRes = await app.request(`${base}/api/chat.deleteScheduledMessage`, {
      method: "POST",
      headers: peerHeaders,
      body: JSON.stringify({ channel: ch.channel_id, scheduled_message_id: scheduled.scheduled_message_id }),
    });
    const peerDelete = (await peerDeleteRes.json()) as any;
    expect(peerDelete.ok).toBe(false);
    expect(peerDelete.error).toBe("cant_delete_message");
    expect(ss.scheduledMessages.findOneBy("scheduled_message_id", scheduled.scheduled_message_id)).toBeDefined();
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
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("handles legacy username channel membership consistently", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.findOneBy("name", "random")!;
    insertSlackTestUser(store, "U000000002", "legacy-member-peer");
    ss.channels.update(ch.id, { members: ["admin", "U000000002"], num_members: 2 });

    const infoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.ok).toBe(true);
    expect(info.channel.is_member).toBe(true);

    const joinRes = await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const joined = (await joinRes.json()) as any;
    expect(joined.ok).toBe(true);
    expect(joined.channel.num_members).toBe(2);
    expect(ss.channels.findOneBy("channel_id", ch.channel_id)?.members).toEqual(["admin", "U000000002"]);

    const leaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    expect(((await leaveRes.json()) as any).ok).toBe(true);
    expect(ss.channels.findOneBy("channel_id", ch.channel_id)?.members).toEqual(["U000000002"]);
  });

  it("hides private channel reads from non-members", async () => {
    insertSlackTestUser(store, "U000000002", "private-outsider");
    tokenMap.set("xoxb-private-outsider-token", { login: "U000000002", id: 2, scopes: ["channels:read"] });
    const outsiderHeaders = {
      Authorization: "Bearer xoxb-private-outsider-token",
      "Content-Type": "application/json",
    };

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "private-read-authz", is_private: true }),
    });
    const channel = ((await createRes.json()) as any).channel.id;

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: "private message" }),
    });
    const posted = (await postRes.json()) as any;

    const listRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ types: "private_channel" }),
    });
    const list = (await listRes.json()) as any;
    expect(list.ok).toBe(true);
    expect(list.channels.map((listed: any) => listed.id)).not.toContain(channel);

    const blockedRequests = [
      { path: "conversations.info", body: { channel } },
      { path: "conversations.history", body: { channel } },
      { path: "conversations.replies", body: { channel, ts: posted.ts } },
      { path: "conversations.join", body: { channel } },
      { path: "conversations.members", body: { channel } },
    ];

    for (const request of blockedRequests) {
      const res = await app.request(`${base}/api/${request.path}`, {
        method: "POST",
        headers: outsiderHeaders,
        body: JSON.stringify(request.body),
      });
      const body = (await res.json()) as any;
      expect(body.ok, request.path).toBe(false);
      expect(body.error, request.path).toBe("not_in_channel");
    }
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

    insertSlackTestUser(store, "U000000002", "lifecycle-state-peer");
    await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, users: "U000000002" }),
    });

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

    insertSlackTestUser(store, "U000000002", "join-test-peer");
    await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, users: "U000000002" }),
    });

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
    expect(joined.channel.num_members).toBe(2);
  });

  it("rejects invalid leave states without mutating membership", async () => {
    const ss = getSlackStore(store);
    const general = ss.channels.findOneBy("name", "general")!;
    const generalLeaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: general.channel_id }),
    });
    const generalLeave = (await generalLeaveRes.json()) as any;
    expect(generalLeave.ok).toBe(false);
    expect(generalLeave.error).toBe("cant_leave_general");
    expect(ss.channels.findOneBy("channel_id", general.channel_id)?.members).toEqual(["U000000001"]);

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "leave-guards" }),
    });
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    const lastMemberLeaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });
    const lastMemberLeave = (await lastMemberLeaveRes.json()) as any;
    expect(lastMemberLeave.ok).toBe(false);
    expect(lastMemberLeave.error).toBe("last_member");
    expect(ss.channels.findOneBy("channel_id", channelId)?.members).toEqual(["U000000001"]);

    insertSlackTestUser(store, "U000000002", "leave-outsider");
    tokenMap.set("xoxb-leave-outsider-token", { login: "U000000002", id: 2, scopes: ["channels:write"] });
    const outsiderLeaveRes = await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-leave-outsider-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
    });
    const outsiderLeave = (await outsiderLeaveRes.json()) as any;
    expect(outsiderLeave).toEqual({ ok: false, not_in_channel: true });
    expect(ss.channels.findOneBy("channel_id", channelId)?.members).toEqual(["U000000001"]);
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

  it("invites and kicks channel members", async () => {
    insertSlackTestUser(store, "U000000002", "teammate");
    const ss = getSlackStore(store);
    const ch = ss.channels.findOneBy("name", "random")!;

    const inviteRes = await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, users: "U000000002" }),
    });
    const invited = (await inviteRes.json()) as any;
    expect(invited.ok).toBe(true);
    expect(invited.channel.members).toBeUndefined();

    const membersRes = await app.request(`${base}/api/conversations.members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const members = (await membersRes.json()) as any;
    expect(members.members).toContain("U000000002");

    const duplicateRes = await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, users: "U000000002" }),
    });
    const duplicate = (await duplicateRes.json()) as any;
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toBe("already_in_channel");

    const kickRes = await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, user: "U000000002" }),
    });
    expect(((await kickRes.json()) as any).ok).toBe(true);

    const afterKickRes = await app.request(`${base}/api/conversations.members`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const afterKick = (await afterKickRes.json()) as any;
    expect(afterKick.members).not.toContain("U000000002");
  });

  it("rejects invalid membership writes", async () => {
    insertSlackTestUser(store, "U000000002", "cannotkick");
    const ss = getSlackStore(store);
    const general = ss.channels.findOneBy("name", "general")!;
    const random = ss.channels.findOneBy("name", "random")!;

    const selfInviteRes = await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id, users: "U000000001" }),
    });
    const selfInvite = (await selfInviteRes.json()) as any;
    expect(selfInvite.ok).toBe(false);
    expect(selfInvite.error).toBe("cant_invite_self");

    const selfKickRes = await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id, user: "U000000001" }),
    });
    const selfKick = (await selfKickRes.json()) as any;
    expect(selfKick.ok).toBe(false);
    expect(selfKick.error).toBe("cant_kick_self");

    const generalKickRes = await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: general.channel_id, user: "U000000002" }),
    });
    const generalKick = (await generalKickRes.json()) as any;
    expect(generalKick.ok).toBe(false);
    expect(generalKick.error).toBe("cant_kick_from_general");

    const inviteRes = await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id, users: "U000000002" }),
    });
    expect(((await inviteRes.json()) as any).ok).toBe(true);

    const archiveRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id }),
    });
    expect(((await archiveRes.json()) as any).ok).toBe(true);

    const archivedKickRes = await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: random.channel_id, user: "U000000002" }),
    });
    const archivedKick = (await archivedKickRes.json()) as any;
    expect(archivedKick.ok).toBe(false);
    expect(archivedKick.error).toBe("is_archived");
    expect(getSlackStore(store).channels.findOneBy("name", "random")?.members).toContain("U000000002");
  });

  it("opens, closes, lists, marks, and posts to direct messages", async () => {
    insertSlackTestUser(store, "U000000002", "dmuser");

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(opened.channel.id).toMatch(/^D/);
    expect(opened.channel.is_im).toBe(true);
    expect(opened.channel.is_open).toBe(true);
    expect(opened.channel.user).toBe("U000000002");

    const listRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ types: "im" }),
    });
    const list = (await listRes.json()) as any;
    expect(list.channels.map((channel: any) => channel.id)).toContain(opened.channel.id);

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "U000000002", text: "hello dm" }),
    });
    const posted = (await postRes.json()) as any;
    expect(posted.ok).toBe(true);
    expect(posted.channel).toBe(opened.channel.id);

    const markRes = await app.request(`${base}/api/conversations.mark`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id, ts: posted.ts }),
    });
    expect(((await markRes.json()) as any).ok).toBe(true);

    const infoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.channel.last_read).toBe(posted.ts);

    const closeRes = await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id }),
    });
    expect(((await closeRes.json()) as any).ok).toBe(true);

    const duplicateCloseRes = await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id }),
    });
    const duplicateClose = (await duplicateCloseRes.json()) as any;
    expect(duplicateClose).toMatchObject({ ok: true, no_op: true, already_closed: true });
  });

  it("does not let direct conversation names reserve channel names", async () => {
    insertSlackTestUser(store, "U000000002", "support");

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(opened.channel.name).toBe("support");

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "support" }),
    });
    const created = (await createRes.json()) as any;
    expect(created.ok).toBe(true);
    expect(created.channel.name).toBe("support");

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "support", text: "channel message" }),
    });
    const posted = (await postRes.json()) as any;
    expect(posted.ok).toBe(true);
    expect(posted.channel).toBe(created.channel.id);
    expect(posted.channel).not.toBe(opened.channel.id);
  });

  it("keeps direct message open state per member and protects channel id writes", async () => {
    insertSlackTestUser(store, "U000000002", "dmpeer");
    insertSlackTestUser(store, "U000000003", "dmoutsider");
    tokenMap.set("xoxb-dm-peer-token", { login: "U000000002", id: 2, scopes: ["chat:write"] });
    tokenMap.set("xoxb-dm-outsider-token", { login: "U000000003", id: 3, scopes: ["chat:write"] });
    const peerHeaders = { Authorization: "Bearer xoxb-dm-peer-token", "Content-Type": "application/json" };
    const outsiderHeaders = { Authorization: "Bearer xoxb-dm-outsider-token", "Content-Type": "application/json" };

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    const channel = opened.channel.id;
    expect(opened.channel.is_open).toBe(true);

    const peerInfoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: peerHeaders,
      body: JSON.stringify({ channel }),
    });
    const peerInfo = (await peerInfoRes.json()) as any;
    expect(peerInfo.channel.is_open).toBe(false);

    const outsiderOpenRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel }),
    });
    const outsiderOpen = (await outsiderOpenRes.json()) as any;
    expect(outsiderOpen.ok).toBe(false);
    expect(outsiderOpen.error).toBe("not_in_channel");

    const outsiderCloseRes = await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel }),
    });
    const outsiderClose = (await outsiderCloseRes.json()) as any;
    expect(outsiderClose.ok).toBe(false);
    expect(outsiderClose.error).toBe("not_in_channel");

    const outsiderPostRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel, text: "blocked direct write" }),
    });
    const outsiderPost = (await outsiderPostRes.json()) as any;
    expect(outsiderPost.ok).toBe(false);
    expect(outsiderPost.error).toBe("not_in_channel");
    expect(getSlackStore(store).messages.findBy("channel_id", channel)).toHaveLength(0);

    const closeRes = await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    expect(((await closeRes.json()) as any).ok).toBe(true);

    const peerOpenRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: peerHeaders,
      body: JSON.stringify({ channel, return_im: true }),
    });
    const peerOpen = (await peerOpenRes.json()) as any;
    expect(peerOpen.ok).toBe(true);
    expect(peerOpen.channel.is_open).toBe(true);

    const adminInfoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    const adminInfo = (await adminInfoRes.json()) as any;
    expect(adminInfo.channel.is_open).toBe(false);
  });

  it("hides direct conversations from non-members and formats IM users per viewer", async () => {
    insertSlackTestUser(store, "U000000002", "privateimone");
    insertSlackTestUser(store, "U000000003", "privateimtwo");
    tokenMap.set("xoxb-private-im-one-token", { login: "U000000002", id: 2, scopes: ["chat:write"] });
    tokenMap.set("xoxb-private-im-two-token", { login: "U000000003", id: 3, scopes: ["chat:write"] });
    const oneHeaders = { Authorization: "Bearer xoxb-private-im-one-token", "Content-Type": "application/json" };
    const twoHeaders = { Authorization: "Bearer xoxb-private-im-two-token", "Content-Type": "application/json" };

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: oneHeaders,
      body: JSON.stringify({ users: "U000000003", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    const channel = opened.channel.id;
    expect(opened.channel.user).toBe("U000000003");

    const participantInfoRes = await app.request(`${base}/api/conversations.info`, {
      method: "POST",
      headers: twoHeaders,
      body: JSON.stringify({ channel }),
    });
    const participantInfo = (await participantInfoRes.json()) as any;
    expect(participantInfo.ok).toBe(true);
    expect(participantInfo.channel.user).toBe("U000000002");

    const participantListRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: twoHeaders,
      body: JSON.stringify({ types: "im" }),
    });
    const participantList = (await participantListRes.json()) as any;
    const participantListed = participantList.channels.find((listed: any) => listed.id === channel);
    expect(participantListed.user).toBe("U000000002");

    const outsiderListRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ types: "im" }),
    });
    const outsiderList = (await outsiderListRes.json()) as any;
    expect(outsiderList.channels.map((listed: any) => listed.id)).not.toContain(channel);

    const blockedReads = [
      { path: "conversations.info", body: { channel } },
      { path: "conversations.history", body: { channel } },
      { path: "conversations.replies", body: { channel, ts: "1234567890.000001" } },
      { path: "conversations.members", body: { channel } },
    ];

    for (const request of blockedReads) {
      const res = await app.request(`${base}/api/${request.path}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(request.body),
      });
      const body = (await res.json()) as any;
      expect(body.ok, request.path).toBe(false);
      expect(body.error, request.path).toBe("not_in_channel");
    }
  });

  it("rejects lifecycle writes for direct conversations", async () => {
    insertSlackTestUser(store, "U000000002", "directlifeone");
    insertSlackTestUser(store, "U000000003", "directlifetwo");

    const dmRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002", return_im: true }),
    });
    const dm = (await dmRes.json()) as any;

    const mpimRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002,U000000003", return_im: true }),
    });
    const mpim = (await mpimRes.json()) as any;

    const unsupportedRequests = [
      { path: "conversations.archive", body: { channel: dm.channel.id } },
      { path: "conversations.unarchive", body: { channel: dm.channel.id } },
      { path: "conversations.rename", body: { channel: dm.channel.id, name: "direct-life-renamed" } },
      { path: "conversations.setTopic", body: { channel: mpim.channel.id, topic: "no topic" } },
      { path: "conversations.setPurpose", body: { channel: mpim.channel.id, purpose: "no purpose" } },
    ];

    for (const request of unsupportedRequests) {
      const res = await app.request(`${base}/api/${request.path}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(request.body),
      });
      const body = (await res.json()) as any;
      expect(body.ok, request.path).toBe(false);
      expect(body.error, request.path).toBe("method_not_supported_for_channel_type");
    }
  });

  it("opens MPIMs and filters conversation list types", async () => {
    insertSlackTestUser(store, "U000000002", "mpimone");
    insertSlackTestUser(store, "U000000003", "mpimtwo");
    insertSlackTestUser(store, "U000000004", "mpimthree");

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002,U000000003", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(opened.channel.id).toMatch(/^G/);
    expect(opened.channel.is_mpim).toBe(true);
    expect(opened.channel.num_members).toBe(3);

    const repeatOpenRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000003,U000000002" }),
    });
    const repeatOpen = (await repeatOpenRes.json()) as any;
    expect(repeatOpen).toMatchObject({ ok: true, no_op: true, already_open: true });
    expect(repeatOpen.channel.id).toBe(opened.channel.id);

    const listRes = await app.request(`${base}/api/conversations.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ types: "mpim" }),
    });
    const list = (await listRes.json()) as any;
    expect(list.channels.map((channel: any) => channel.id)).toContain(opened.channel.id);
    expect(list.channels.every((channel: any) => channel.is_mpim)).toBe(true);

    const inviteRes = await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id, users: "U000000004" }),
    });
    expect(((await inviteRes.json()) as any).ok).toBe(true);

    const kickRes = await app.request(`${base}/api/conversations.kick`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id, user: "U000000004" }),
    });
    expect(((await kickRes.json()) as any).ok).toBe(true);
  });
});

describe("Slack plugin - users", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("gets and sets profile fields", async () => {
    const getRes = await app.request(`${base}/api/users.profile.get?user=U000000001`, {
      method: "GET",
      headers: authHeaders(),
    });
    const initial = (await getRes.json()) as any;
    expect(initial.ok).toBe(true);
    expect(initial.profile.display_name).toBe("admin");
    expect(initial.profile.status_text).toBe("");

    const setRes = await app.request(`${base}/api/users.profile.set`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user: "U000000001",
        profile: {
          display_name: "Admin Ops",
          real_name: "Admin Operator",
          title: "Incident Commander",
          phone: "+1 555 0100",
          pronouns: "they/them",
          status_text: "Watching deploys",
          status_emoji: ":eyes:",
          status_expiration: 0,
          fields: { Xf0000001: { value: "Platform", alt: "" } },
        },
      }),
    });
    const set = (await setRes.json()) as any;
    expect(set.ok).toBe(true);
    expect(set.profile).toMatchObject({
      display_name: "Admin Ops",
      display_name_normalized: "Admin Ops",
      real_name: "Admin Operator",
      real_name_normalized: "Admin Operator",
      title: "Incident Commander",
      phone: "+1 555 0100",
      pronouns: "they/them",
      status_text: "Watching deploys",
      status_emoji: ":eyes:",
      fields: { Xf0000001: { value: "Platform", alt: "" } },
    });

    const stored = getSlackStore(store).users.findOneBy("user_id", "U000000001");
    expect(stored?.real_name).toBe("Admin Operator");
    expect(stored?.profile.display_name).toBe("Admin Ops");
  });

  it("sets a single profile field from form data", async () => {
    const form = new URLSearchParams();
    form.set("user", "U000000001");
    form.set("name", "status_text");
    form.set("value", "On call");

    const res = await app.request(`${base}/api/users.profile.set`, {
      method: "POST",
      headers: authHeaders("application/x-www-form-urlencoded"),
      body: form.toString(),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.profile.status_text).toBe("On call");
  });

  it("gets and sets presence", async () => {
    const initialRes = await app.request(`${base}/api/users.getPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user: "U000000001" }),
    });
    const initial = (await initialRes.json()) as any;
    expect(initial).toMatchObject({
      ok: true,
      presence: "active",
      online: true,
      manual_away: false,
      connection_count: 1,
    });

    const awayRes = await app.request(`${base}/api/users.setPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ presence: "away" }),
    });
    expect(((await awayRes.json()) as any).ok).toBe(true);

    const awayPresenceRes = await app.request(`${base}/api/users.getPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user: "U000000001" }),
    });
    const awayPresence = (await awayPresenceRes.json()) as any;
    expect(awayPresence).toMatchObject({
      ok: true,
      presence: "away",
      online: false,
      manual_away: true,
      connection_count: 0,
    });

    const autoRes = await app.request(`${base}/api/users.setPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ presence: "auto" }),
    });
    expect(((await autoRes.json()) as any).ok).toBe(true);
    expect(getSlackStore(store).users.findOneBy("user_id", "U000000001")?.presence).toBe("active");
  });

  it("returns invalid_presence for unsupported presence values", async () => {
    const res = await app.request(`${base}/api/users.setPresence`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ presence: "busy" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_presence");
  });

  it("enforces profile and presence scopes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-profile-read-token", { login: "U000000001", id: 1, scopes: ["users.profile:read"] });

    const profileGetRes = await app.request(`${base}/api/users.profile.get`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-profile-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ user: "U000000001" }),
    });
    expect(((await profileGetRes.json()) as any).ok).toBe(true);

    const profileSetMissingRes = await app.request(`${base}/api/users.profile.set`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-profile-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { display_name: "Nope" } }),
    });
    const profileSetMissing = (await profileSetMissingRes.json()) as any;
    expect(profileSetMissing.ok).toBe(false);
    expect(profileSetMissing.error).toBe("missing_scope");
    expect(profileSetMissing.needed).toBe("users.profile:write");

    tokenMap.set("xoxb-presence-read-token", { login: "U000000001", id: 1, scopes: ["users:read"] });
    const presenceRes = await app.request(`${base}/api/users.getPresence`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-presence-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ user: "U000000001" }),
    });
    expect(((await presenceRes.json()) as any).ok).toBe(true);

    const presenceSetMissingRes = await app.request(`${base}/api/users.setPresence`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-presence-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ presence: "away" }),
    });
    const presenceSetMissing = (await presenceSetMissingRes.json()) as any;
    expect(presenceSetMissing.ok).toBe(false);
    expect(presenceSetMissing.error).toBe("missing_scope");
    expect(presenceSetMissing.needed).toBe("users:write");
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
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
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

  it("blocks non-member reactions on private channels", async () => {
    insertSlackTestUser(store, "U000000002", "reaction-outsider");
    tokenMap.set("xoxb-reaction-outsider-token", { login: "U000000002", id: 2, scopes: ["reactions:write"] });
    const outsiderHeaders = {
      Authorization: "Bearer xoxb-reaction-outsider-token",
      "Content-Type": "application/json",
    };

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "private-reactions", is_private: true }),
    });
    const channel = ((await createRes.json()) as any).channel.id;

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: "private reaction target" }),
    });
    const posted = (await postRes.json()) as any;

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts, name: "lock" }),
    });

    const blockedRequests = [
      { path: "reactions.get", body: { channel, timestamp: posted.ts } },
      { path: "reactions.add", body: { channel, timestamp: posted.ts, name: "eyes" } },
      { path: "reactions.remove", body: { channel, timestamp: posted.ts, name: "lock" } },
    ];

    for (const request of blockedRequests) {
      const res = await app.request(`${base}/api/${request.path}`, {
        method: "POST",
        headers: outsiderHeaders,
        body: JSON.stringify(request.body),
      });
      const body = (await res.json()) as any;
      expect(body.ok, request.path).toBe(false);
      expect(body.error, request.path).toBe("not_in_channel");
    }

    const msg = getSlackStore(store).messages.findOneBy("ts", posted.ts)!;
    expect(msg.reactions).toHaveLength(1);
    expect(msg.reactions[0]).toMatchObject({ name: "lock", count: 1 });
  });

  it("blocks non-member reactions on direct messages", async () => {
    insertSlackTestUser(store, "U000000002", "reaction-dm-peer");
    insertSlackTestUser(store, "U000000003", "reaction-dm-outsider");
    tokenMap.set("xoxb-reaction-dm-outsider-token", { login: "U000000003", id: 3, scopes: ["reactions:write"] });
    const outsiderHeaders = {
      Authorization: "Bearer xoxb-reaction-dm-outsider-token",
      "Content-Type": "application/json",
    };

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000002", return_im: true }),
    });
    const channel = ((await openRes.json()) as any).channel.id;

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: "dm reaction target" }),
    });
    const posted = (await postRes.json()) as any;

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts, name: "lock" }),
    });

    const getRes = await app.request(`${base}/api/reactions.get`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    const getBody = (await getRes.json()) as any;
    expect(getBody.ok).toBe(false);
    expect(getBody.error).toBe("not_in_channel");

    const addRes = await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel, timestamp: posted.ts, name: "eyes" }),
    });
    const addBody = (await addRes.json()) as any;
    expect(addBody.ok).toBe(false);
    expect(addBody.error).toBe("not_in_channel");

    const removeRes = await app.request(`${base}/api/reactions.remove`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel, timestamp: posted.ts, name: "lock" }),
    });
    const removeBody = (await removeRes.json()) as any;
    expect(removeBody.ok).toBe(false);
    expect(removeBody.error).toBe("not_in_channel");
    expect(getSlackStore(store).messages.findOneBy("ts", posted.ts)?.reactions).toEqual([
      expect.objectContaining({ name: "lock", count: 1 }),
    ]);
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
        {
          name: "alice",
          real_name: "Alice Smith",
          email: "alice@acme.com",
          is_admin: true,
          presence: "away",
          profile: {
            title: "Staff Engineer",
            phone: "+1 555 0101",
            pronouns: "she/her",
            status_text: "Deep work",
            status_emoji: ":hammer_and_wrench:",
          },
        },
        { name: "bob", email: "bob@acme.com" },
      ],
      channels: [
        { name: "engineering", topic: "Code talk" },
        { name: "secret", is_private: true },
      ],
      bots: [{ name: "deploy-bot" }],
      oauth_apps: [
        {
          app_id: "A000000001",
          client_id: "12345.67890",
          client_secret: "test-secret",
          name: "Deploy App",
          redirect_uris: ["http://localhost:3000/callback"],
          scopes: ["chat:write", "channels:read"],
          user_scopes: ["users:read"],
          bot_id: "B000000099",
          bot_user_id: "U000000099",
        },
      ],
      tokens: [{ token: "xoxb-seeded-slack-token", user: "alice", scopes: ["chat:write"] }],
      strict_scopes: true,
    });

    const ss = getSlackStore(store);

    const team = ss.teams.all()[0];
    expect(team.name).toBe("Acme Corp");
    expect(team.domain).toBe("acme");

    const users = ss.users.all();
    expect(users.length).toBe(4); // admin + alice + bob + app bot user
    const alice = users.find((user) => user.name === "alice");
    expect(alice?.presence).toBe("away");
    expect(alice?.manual_presence).toBe("away");
    expect(alice?.profile).toMatchObject({
      title: "Staff Engineer",
      phone: "+1 555 0101",
      pronouns: "she/her",
      status_text: "Deep work",
      status_emoji: ":hammer_and_wrench:",
    });

    const channels = ss.channels.all();
    expect(channels.length).toBe(4); // general + random + engineering + secret
    const eng = channels.find((c) => c.name === "engineering");
    expect(eng?.topic.value).toBe("Code talk");
    const secret = channels.find((c) => c.name === "secret");
    expect(secret?.is_private).toBe(true);

    const bots = ss.bots.all();
    expect(bots.length).toBe(2);
    expect(bots.map((bot) => bot.name)).toContain("deploy-bot");
    expect(bots.map((bot) => bot.bot_id)).toContain("B000000099");

    const oauthApp = ss.oauthApps.findOneBy("client_id", "12345.67890");
    expect(oauthApp?.app_id).toBe("A000000001");
    expect(oauthApp?.scopes).toEqual(["chat:write", "channels:read"]);
    expect(oauthApp?.user_scopes).toEqual(["users:read"]);

    const token = ss.tokens.findOneBy("token", "xoxb-seeded-slack-token");
    expect(token?.user_id).toBe(alice?.user_id);
    expect(token?.scopes).toEqual(["chat:write"]);
    expect(ss.installations.findOneBy("app_id", "A000000001")).toMatchObject({
      client_id: "12345.67890",
      bot_id: "B000000099",
      bot_user_id: "U000000099",
      scopes: ["chat:write", "channels:read"],
      user_scopes: ["users:read"],
    });
    expect(store.getData("slack.strict_scopes")).toBe(true);
  });
});

describe("Slack plugin - OAuth flow", () => {
  let app: SlackTestApp["app"];
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    const ss = getSlackStore(setup.store);
    ss.oauthApps.insert({
      app_id: "A000000001",
      client_id: "12345.67890",
      client_secret: "test-secret",
      name: "Test App",
      redirect_uris: ["http://localhost:3000/callback"],
      scopes: ["chat:write", "channels:read"],
      user_scopes: ["users:read"],
      bot_id: "B000000099",
      bot_user_id: "U000000099",
      bot_name: "test-app",
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
      `${base}/oauth/v2/authorize?client_id=12345.67890&redirect_uri=http://localhost:3000/callback&scope=chat:write,channels:read&user_scope=users:read&state=xyz`,
    );
    expect(authRes.status).toBe(200);

    // Simulate the callback (user clicks approve)
    const callbackRes = await app.request(`${base}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `user_id=U000000001&redirect_uri=http://localhost:3000/callback&scope=chat:write,channels:read&user_scope=users:read&state=xyz&client_id=12345.67890`,
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toBeDefined();

    // Exchange code for token
    const tokenRes = await app.request(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `code=${code}&client_id=12345.67890&client_secret=test-secret&redirect_uri=http://localhost:3000/callback`,
    });
    const token = (await tokenRes.json()) as any;
    expect(token.ok).toBe(true);
    expect(token.access_token).toMatch(/^xoxb-/);
    expect(token.token_type).toBe("bot");
    expect(token.scope).toBe("chat:write,channels:read");
    expect(token.bot_user_id).toBe("U000000099");
    expect(token.app_id).toBe("A000000001");
    expect(token.team.name).toBe("Emulate");
    expect(token.enterprise).toBeNull();
    expect(token.is_enterprise_install).toBe(false);
    expect(token.authed_user.id).toBe("U000000001");
    expect(token.authed_user.access_token).toMatch(/^xoxp-/);
    expect(token.authed_user.scope).toBe("users:read");
    expect(token.authed_user.token_type).toBe("user");

    const ss = getSlackStore(store);
    const installation = ss.installations.findOneBy("app_id", "A000000001");
    expect(installation).toMatchObject({
      client_id: "12345.67890",
      team_id: "T000000001",
      installer_user_id: "U000000001",
      bot_id: "B000000099",
      bot_user_id: "U000000099",
      scopes: ["chat:write", "channels:read"],
      user_scopes: ["users:read"],
    });
    expect(ss.users.findOneBy("user_id", "U000000099")?.is_bot).toBe(true);
    expect(ss.tokens.findOneBy("token", token.access_token)).toMatchObject({
      token_type: "bot",
      app_id: "A000000001",
      user_id: "U000000099",
      authed_user_id: "U000000001",
    });

    const authTestRes = await app.request(`${base}/api/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const authTest = (await authTestRes.json()) as any;
    expect(authTest.ok).toBe(true);
    expect(authTest.user_id).toBe("U000000099");
    expect(authTest.bot_id).toBe("B000000099");
    expect(authTest.app_id).toBe("A000000001");
  });

  it("does not issue a user token unless user_scope is requested", async () => {
    const callbackRes = await app.request(`${base}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `user_id=U000000001&redirect_uri=http://localhost:3000/callback&scope=chat:write,channels:read&state=xyz&client_id=12345.67890`,
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toBeDefined();

    const tokenRes = await app.request(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `code=${code}&client_id=12345.67890&client_secret=test-secret&redirect_uri=http://localhost:3000/callback`,
    });
    const token = (await tokenRes.json()) as any;
    expect(token.ok).toBe(true);
    expect(token.access_token).toMatch(/^xoxb-/);
    expect(token.authed_user).toEqual({ id: "U000000001" });

    const ss = getSlackStore(store);
    expect(ss.tokens.findBy("token_type", "user")).toEqual([]);
    expect(ss.installations.findOneBy("app_id", "A000000001")?.user_scopes).toEqual([]);
  });
});

describe("Slack plugin - scope modes", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
  });

  it("keeps missing scope checks relaxed by default", async () => {
    tokenMap.set("xoxb-relaxed-token", { login: "U000000001", id: 1, scopes: [] });
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-relaxed-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C000000001", text: "relaxed" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("returns missing_scope in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-missing-scope-token", { login: "U000000001", id: 1, scopes: ["channels:read"] });

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-missing-scope-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C000000001", text: "strict" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("missing_scope");
    expect(body.needed).toBe("chat:write");
    expect(body.provided).toBe("channels:read");
  });

  it("accepts channels:write for public channel writes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-public-channel-write-token", { login: "U000000001", id: 1, scopes: ["channels:write"] });
    const headers = {
      Authorization: "Bearer xoxb-public-channel-write-token",
      "Content-Type": "application/json",
    };

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "strict-public-write" }),
    });
    const created = (await createRes.json()) as any;
    expect(created.ok).toBe(true);

    const topicRes = await app.request(`${base}/api/conversations.setTopic`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channel: created.channel.id, topic: "via channels:write" }),
    });
    const topic = (await topicRes.json()) as any;
    expect(topic.ok).toBe(true);
    expect(topic.channel.topic.value).toBe("via channels:write");
  });

  it("hides user emails without users:read.email in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-users-read-token", { login: "U000000001", id: 1, scopes: ["users:read"] });

    const infoRes = await app.request(`${base}/api/users.info`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-users-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ user: "U000000001" }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.ok).toBe(true);
    expect(info.user.profile.email).toBeUndefined();

    tokenMap.set("xoxb-users-email-token", {
      login: "U000000001",
      id: 1,
      scopes: ["users:read", "users:read.email"],
    });
    const emailRes = await app.request(`${base}/api/users.info`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-users-email-token", "Content-Type": "application/json" },
      body: JSON.stringify({ user: "U000000001" }),
    });
    const email = (await emailRes.json()) as any;
    expect(email.ok).toBe(true);
    expect(email.user.profile.email).toBe("admin@emulate.dev");
  });

  it("allows lookup by email with only users:read.email in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-users-email-only-token", {
      login: "U000000001",
      id: 1,
      scopes: ["users:read.email"],
    });

    const res = await app.request(`${base}/api/users.lookupByEmail`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-users-email-only-token", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@emulate.dev" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.user.profile.email).toBe("admin@emulate.dev");
  });

  it("requires team and bot info scopes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    getSlackStore(store).bots.insert({
      bot_id: "B000000777",
      name: "strict-bot",
      deleted: false,
      icons: { image_48: "" },
    });
    tokenMap.set("xoxb-no-team-scope-token", { login: "U000000001", id: 1, scopes: ["users:read"] });

    const missingTeamRes = await app.request(`${base}/api/team.info`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-no-team-scope-token" },
    });
    const missingTeam = (await missingTeamRes.json()) as any;
    expect(missingTeam.ok).toBe(false);
    expect(missingTeam.error).toBe("missing_scope");
    expect(missingTeam.needed).toBe("team:read");

    tokenMap.set("xoxb-team-read-token", { login: "U000000001", id: 1, scopes: ["team:read"] });
    const teamRes = await app.request(`${base}/api/team.info`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-team-read-token" },
    });
    const team = (await teamRes.json()) as any;
    expect(team.ok).toBe(true);

    tokenMap.set("xoxb-no-users-scope-token", { login: "U000000001", id: 1, scopes: ["team:read"] });
    const missingBotRes = await app.request(`${base}/api/bots.info`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-no-users-scope-token", "Content-Type": "application/json" },
      body: JSON.stringify({ bot: "B000000777" }),
    });
    const missingBot = (await missingBotRes.json()) as any;
    expect(missingBot.ok).toBe(false);
    expect(missingBot.error).toBe("missing_scope");
    expect(missingBot.needed).toBe("users:read");
  });

  it("requires history scopes for history and replies in strict mode", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.findOneBy("name", "general")!;

    const parentRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "strict history parent" }),
    });
    const parent = (await parentRes.json()) as any;
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "strict history reply", thread_ts: parent.ts }),
    });

    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-read-only-history-token", { login: "U000000001", id: 1, scopes: ["channels:read"] });
    const readHeaders = {
      Authorization: "Bearer xoxb-read-only-history-token",
      "Content-Type": "application/json",
    };

    const historyMissingRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const historyMissing = (await historyMissingRes.json()) as any;
    expect(historyMissing.ok).toBe(false);
    expect(historyMissing.error).toBe("missing_scope");
    expect(historyMissing.needed).toBe("channels:history");

    const repliesMissingRes = await app.request(`${base}/api/conversations.replies`, {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({ channel: ch.channel_id, ts: parent.ts }),
    });
    const repliesMissing = (await repliesMissingRes.json()) as any;
    expect(repliesMissing.ok).toBe(false);
    expect(repliesMissing.error).toBe("missing_scope");
    expect(repliesMissing.needed).toBe("channels:history");

    tokenMap.set("xoxb-history-token", { login: "U000000001", id: 1, scopes: ["channels:history"] });
    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-history-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: ch.channel_id }),
    });
    const history = (await historyRes.json()) as any;
    expect(history.ok).toBe(true);
    expect(history.messages.length).toBeGreaterThan(0);
  });

  it("accepts channels:join for public channel joins in strict mode", async () => {
    insertSlackTestUser(store, "U000000002", "strict-join-peer");

    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "strict-join-scope" }),
    });
    const created = (await createRes.json()) as any;
    const channelId = created.channel.id;

    await app.request(`${base}/api/conversations.invite`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId, users: "U000000002" }),
    });

    await app.request(`${base}/api/conversations.leave`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channelId }),
    });

    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-manage-only-join-token", { login: "U000000001", id: 1, scopes: ["channels:manage"] });

    const missingRes = await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-manage-only-join-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId }),
    });
    const missing = (await missingRes.json()) as any;
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("missing_scope");
    expect(missing.needed).toBe("channels:join|channels:write");
    expect(missing.provided).toBe("channels:manage");

    tokenMap.set("xoxb-join-token", { login: "U000000001", id: 1, scopes: ["channels:join"] });
    const joinRes = await app.request(`${base}/api/conversations.join`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-join-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId }),
    });
    const joined = (await joinRes.json()) as any;
    expect(joined.ok).toBe(true);
    expect(joined.channel.is_member).toBe(true);
  });

  it("authenticates seeded Slack token records in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    getSlackStore(store).tokens.insert({
      token: "xoxb-store-token",
      token_type: "test",
      team_id: "T000000001",
      user_id: "U000000001",
      scopes: ["chat:write"],
    });

    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-store-token", "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C000000001", text: "seeded token" }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message.user).toBe("U000000001");
  });

  it("normalizes seeded token user names to Slack user ids", async () => {
    seedFromConfig(store, base, {
      users: [{ name: "developer", real_name: "Developer", email: "dev@example.com" }],
      tokens: [{ token: "xoxb-developer-token", user: "developer", scopes: ["chat:write", "reactions:write"] }],
    });
    store.setData("slack.strict_scopes", true);

    const ss = getSlackStore(store);
    const developer = ss.users.findOneBy("name", "developer")!;
    const headers = { Authorization: "Bearer xoxb-developer-token", "Content-Type": "application/json" };

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channel: "C000000001", text: "seeded named token" }),
    });
    const posted = (await postRes.json()) as any;
    expect(posted.ok).toBe(true);
    expect(posted.message.user).toBe(developer.user_id);

    const reactionRes = await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channel: "C000000001", timestamp: posted.ts, name: "white_check_mark" }),
    });
    expect(((await reactionRes.json()) as any).ok).toBe(true);
    expect(ss.messages.findOneBy("ts", posted.ts)?.reactions).toEqual([
      { name: "white_check_mark", users: [developer.user_id], count: 1 },
    ]);
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

describe("Slack plugin - files", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
  });

  it("uploads, completes, reads, lists, downloads, and deletes files", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const content = "deploy log\ncomplete\n";

    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "deploy.txt", length: Buffer.byteLength(content), alt_text: "Deploy log" }),
    });
    const upload = (await urlRes.json()) as any;
    expect(upload.ok).toBe(true);
    expect(upload.file_id).toMatch(/^F/);
    expect(upload.upload_url).toBe(`${base}/upload/v1/${upload.file_id}`);

    const bytesRes = await app.request(upload.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    });
    expect(bytesRes.status).toBe(200);

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "Deploy Log" }],
        channel_id: channel,
        initial_comment: "Uploaded deploy log",
      }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(true);
    expect(completed.files[0]).toMatchObject({
      id: upload.file_id,
      name: "deploy.txt",
      title: "Deploy Log",
      mimetype: "text/plain",
      filetype: "txt",
      channels: [channel],
      is_public: true,
      alt_txt: "Deploy log",
    });

    const stored = getSlackStore(store).files.findOneBy("file_id", upload.file_id)!;
    expect(Buffer.from(stored.content_base64!, "base64").toString("utf8")).toBe(content);

    const message = getSlackStore(store).messages.findBy("channel_id", channel)[0];
    expect(message.subtype).toBe("file_share");
    expect(message.text).toBe("Uploaded deploy log");
    expect(message.files?.[0].file_id).toBe(upload.file_id);

    const infoRes = await app.request(`${base}/api/files.info?file=${upload.file_id}`, {
      method: "GET",
      headers: authHeaders(),
    });
    const info = (await infoRes.json()) as any;
    expect(info.ok).toBe(true);
    expect(info.file.title).toBe("Deploy Log");

    const listRes = await app.request(`${base}/api/files.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    const list = (await listRes.json()) as any;
    expect(list.ok).toBe(true);
    expect(list.files.map((file: any) => file.id)).toContain(upload.file_id);
    expect(list.paging.total).toBe(1);

    const downloadRes = await app.request(`${base}/files-pri/${upload.file_id}/deploy.txt`, {
      headers: authHeaders(),
    });
    expect(downloadRes.status).toBe(200);
    expect(Buffer.from(await downloadRes.arrayBuffer()).toString("utf8")).toBe(content);

    const anonymousDownloadRes = await app.request(`${base}/files-pri/${upload.file_id}/deploy.txt`);
    expect(anonymousDownloadRes.status).toBe(401);

    const inspectorRes = await app.request(`${base}/?channel=${channel}`);
    const inspector = await inspectorRes.text();
    expect(inspector).toContain("Uploaded deploy log");
    expect(inspector).toContain("1 file");

    const deleteRes = await app.request(`${base}/api/files.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ file: upload.file_id }),
    });
    expect(((await deleteRes.json()) as any).ok).toBe(true);

    const missingInfoRes = await app.request(`${base}/api/files.info`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ file: upload.file_id }),
    });
    expect(((await missingInfoRes.json()) as any).error).toBe("file_not_found");

    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    const history = (await historyRes.json()) as any;
    const deletedFileShare = history.messages.find((item: any) => item.ts === message.ts);
    expect(deletedFileShare.files).toEqual([]);
    expect(JSON.stringify(deletedFileShare)).not.toContain(upload.file_id);
  });

  it("removes deleted files from threaded file share replies", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const parentRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: "Thread parent" }),
    });
    const parent = (await parentRes.json()) as any;

    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "thread.txt", length: 13 }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "thread upload" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "Thread Upload" }],
        channel_id: channel,
        initial_comment: "Thread file",
        thread_ts: parent.ts,
      }),
    });
    expect(((await completeRes.json()) as any).ok).toBe(true);

    const deleteRes = await app.request(`${base}/api/files.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ file: upload.file_id }),
    });
    expect(((await deleteRes.json()) as any).ok).toBe(true);

    const repliesRes = await app.request(`${base}/api/conversations.replies`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, ts: parent.ts }),
    });
    const replies = (await repliesRes.json()) as any;
    const deletedFileReply = replies.messages.find((item: any) => item.subtype === "file_share");
    expect(deletedFileReply.files).toEqual([]);
    expect(JSON.stringify(deletedFileReply)).not.toContain(upload.file_id);
  });

  it("uses the configured base URL for generated file URLs", async () => {
    const prefixedBase = `${base}/emulate/slack`;
    const setup = createTestApp(prefixedBase);
    const channel = getSlackStore(setup.store).channels.findOneBy("name", "general")!.channel_id;

    const urlRes = await setup.app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "prefixed.txt", length: 8 }),
    });
    const upload = (await urlRes.json()) as any;
    expect(upload.upload_url).toBe(`${prefixedBase}/upload/v1/${upload.file_id}`);

    await setup.app.request(`${base}/upload/v1/${upload.file_id}`, { method: "POST", body: "prefixed" });

    const completeRes = await setup.app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ files: [{ id: upload.file_id, title: "Prefixed" }], channel_id: channel }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(true);
    expect(completed.files[0].url_private).toBe(`${prefixedBase}/files-pri/${upload.file_id}/prefixed.txt`);
    expect(completed.files[0].url_private_download).toBe(
      `${prefixedBase}/files-pri/${upload.file_id}/prefixed.txt?download=1`,
    );
  });

  it("accepts multipart uploads with the documented filename field", async () => {
    const content = "multipart upload";
    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "multipart.txt", length: Buffer.byteLength(content) }),
    });
    const upload = (await urlRes.json()) as any;

    const form = new FormData();
    form.append("filename", new Blob([content], { type: "text/plain" }), "multipart.txt");
    const bytesRes = await app.request(upload.upload_url, {
      method: "POST",
      body: form,
    });
    expect(bytesRes.status).toBe(200);

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ files: [{ id: upload.file_id, title: "Multipart" }] }),
    });
    expect(((await completeRes.json()) as any).ok).toBe(true);

    const stored = getSlackStore(store).files.findOneBy("file_id", upload.file_id)!;
    expect(Buffer.from(stored.content_base64!, "base64").toString("utf8")).toBe(content);
  });

  it("ignores blocks when completing a file upload with an initial comment", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Block detail" } }];

    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "blocks.txt", length: 6 }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "blocks" });

    const params = new URLSearchParams({
      files: JSON.stringify([{ id: upload.file_id, title: "Blocks" }]),
      channel_id: channel,
      initial_comment: "Comment with blocks",
      blocks: JSON.stringify(blocks),
    });
    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders("application/x-www-form-urlencoded"),
      body: params,
    });
    expect(((await completeRes.json()) as any).ok).toBe(true);

    const message = getSlackStore(store).messages.findBy("channel_id", channel)[0];
    expect(message.text).toBe("Comment with blocks");
    expect(message.blocks).toBeUndefined();
  });

  it("supports private completion without sharing to a channel", async () => {
    const content = "private note";
    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "private.md", length: Buffer.byteLength(content), snippet_type: "markdown" }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: content });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ files: [{ id: upload.file_id, title: "Private Note" }] }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(true);
    expect(completed.files[0]).toMatchObject({
      id: upload.file_id,
      channels: [],
      groups: [],
      ims: [],
      is_public: false,
      mode: "snippet",
      filetype: "markdown",
    });
    expect(getSlackStore(store).messages.all()).toHaveLength(0);
  });

  it("hides private channel files from users who cannot access them", async () => {
    const ss = getSlackStore(store);
    ss.users.insert({
      user_id: "U000000002",
      team_id: "T000000001",
      name: "files-outsider",
      real_name: "Files Outsider",
      email: "files-outsider@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "files-outsider",
        real_name: "Files Outsider",
        email: "files-outsider@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });
    tokenMap.set("xoxb-file-outsider-token", {
      login: "U000000002",
      id: 2,
      scopes: ["files:read", "files:write"],
    });
    const privateChannel = ss.channels.insert({
      channel_id: "G000000001",
      team_id: "T000000001",
      name: "secrets",
      is_channel: false,
      is_private: true,
      is_archived: false,
      topic: { value: "", creator: "U000000001", last_set: 0 },
      purpose: { value: "", creator: "U000000001", last_set: 0 },
      members: ["U000000001"],
      creator: "U000000001",
      num_members: 1,
    });

    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "secret.txt", length: 11 }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "secret data" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ files: [{ id: upload.file_id, title: "Secret" }], channel_id: privateChannel.channel_id }),
    });
    expect(((await completeRes.json()) as any).ok).toBe(true);

    const outsiderHeaders = {
      Authorization: "Bearer xoxb-file-outsider-token",
      "Content-Type": "application/json",
    };
    const outsiderInfoRes = await app.request(`${base}/api/files.info`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ file: upload.file_id }),
    });
    expect(((await outsiderInfoRes.json()) as any).error).toBe("file_not_found");

    const outsiderListRes = await app.request(`${base}/api/files.list`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: privateChannel.channel_id }),
    });
    const outsiderList = (await outsiderListRes.json()) as any;
    expect(outsiderList.ok).toBe(true);
    expect(outsiderList.files).toEqual([]);

    const outsiderDownloadRes = await app.request(`${base}/files-pri/${upload.file_id}/secret.txt`, {
      headers: { Authorization: "Bearer xoxb-file-outsider-token" },
    });
    expect(outsiderDownloadRes.status).toBe(404);

    const ownerDownloadRes = await app.request(`${base}/files-pri/${upload.file_id}/secret.txt`, {
      headers: authHeaders(),
    });
    expect(ownerDownloadRes.status).toBe(200);
    expect(await ownerDownloadRes.text()).toBe("secret data");
  });

  it("filters private share metadata when a public file is also shared privately", async () => {
    const ss = getSlackStore(store);
    ss.users.insert({
      user_id: "U000000003",
      team_id: "T000000001",
      name: "mixed-outsider",
      real_name: "Mixed Outsider",
      email: "mixed-outsider@emulate.dev",
      is_admin: false,
      is_bot: false,
      deleted: false,
      profile: {
        display_name: "mixed-outsider",
        real_name: "Mixed Outsider",
        email: "mixed-outsider@emulate.dev",
        image_48: "",
        image_192: "",
      },
    });
    tokenMap.set("xoxb-mixed-outsider-token", {
      login: "U000000003",
      id: 3,
      scopes: ["files:read"],
    });
    const publicChannel = ss.channels.findOneBy("name", "general")!.channel_id;
    const privateChannel = ss.channels.insert({
      channel_id: "G000000003",
      team_id: "T000000001",
      name: "mixed-secrets",
      is_channel: false,
      is_private: true,
      is_archived: false,
      topic: { value: "", creator: "U000000001", last_set: 0 },
      purpose: { value: "", creator: "U000000001", last_set: 0 },
      members: ["U000000001"],
      creator: "U000000001",
      num_members: 1,
    });

    const urlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "mixed.txt", length: 5 }),
    });
    const upload = (await urlRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "mixed" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "Mixed" }],
        channels: `${privateChannel.channel_id},${publicChannel}`,
      }),
    });
    expect(((await completeRes.json()) as any).ok).toBe(true);

    const outsiderHeaders = {
      Authorization: "Bearer xoxb-mixed-outsider-token",
      "Content-Type": "application/json",
    };
    const infoRes = await app.request(`${base}/api/files.info`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ file: upload.file_id }),
    });
    const info = (await infoRes.json()) as any;
    expect(info.ok).toBe(true);
    expect(info.file.channels).toEqual([publicChannel]);
    expect(info.file.groups).toEqual([]);
    expect(info.file.shares.public[publicChannel]).toHaveLength(1);
    expect(info.file.shares.private).toBeUndefined();

    const privateListRes = await app.request(`${base}/api/files.list`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: privateChannel.channel_id }),
    });
    const privateList = (await privateListRes.json()) as any;
    expect(privateList.ok).toBe(true);
    expect(privateList.files).toEqual([]);

    const publicListRes = await app.request(`${base}/api/files.list`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: publicChannel }),
    });
    const publicList = (await publicListRes.json()) as any;
    expect(publicList.ok).toBe(true);
    expect(publicList.files.map((file: any) => file.id)).toContain(upload.file_id);

    const historyRes = await app.request(`${base}/api/conversations.history`, {
      method: "POST",
      headers: outsiderHeaders,
      body: JSON.stringify({ channel: publicChannel }),
    });
    const history = (await historyRes.json()) as any;
    expect(history.ok).toBe(true);
    const fileShare = history.messages.find((message: any) => message.subtype === "file_share");
    expect(fileShare.files[0].channels).toEqual([publicChannel]);
    expect(fileShare.files[0].groups).toEqual([]);
    expect(fileShare.files[0].shares.private).toBeUndefined();
  });

  it("does not partially complete multi-file uploads when one file is invalid", async () => {
    const firstUrlRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "first.txt", length: 5 }),
    });
    const firstUpload = (await firstUrlRes.json()) as any;
    await app.request(firstUpload.upload_url, { method: "POST", body: "first" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [
          { id: firstUpload.file_id, title: "First" },
          { id: "F000000404", title: "Missing" },
        ],
      }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(false);
    expect(completed.error).toBe("file_not_found");

    const ss = getSlackStore(store);
    expect(ss.files.findOneBy("file_id", firstUpload.file_id)).toBeUndefined();
    expect(ss.fileUploadSessions.findOneBy("file_id", firstUpload.file_id)?.completed).toBe(false);
    expect(ss.messages.all()).toHaveLength(0);
  });

  it("rejects malformed complete upload file entries without completing valid uploads", async () => {
    const uploadRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "malformed.txt", length: 9 }),
    });
    const upload = (await uploadRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "malformed" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ files: [{ id: upload.file_id, title: "Valid" }, {}] }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(false);
    expect(completed.error).toBe("invalid_arguments");

    const ss = getSlackStore(store);
    expect(ss.files.findOneBy("file_id", upload.file_id)).toBeUndefined();
    expect(ss.fileUploadSessions.findOneBy("file_id", upload.file_id)?.completed).toBe(false);
    expect(ss.messages.all()).toHaveLength(0);
  });

  it("does not create direct messages when file completion validation fails", async () => {
    insertSlackTestUser(store, "U000000002", "file-dm-target");

    const uploadRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "dm-failure.txt", length: 7 }),
    });
    const upload = (await uploadRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "failure" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "DM Failure" }],
        channel_id: "U000000002",
        blocks: "not-json",
      }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(false);
    expect(completed.error).toBe("invalid_blocks");

    const ss = getSlackStore(store);
    expect(ss.channels.all().filter((channel) => channel.is_im)).toHaveLength(0);
    expect(ss.files.findOneBy("file_id", upload.file_id)).toBeUndefined();
    expect(ss.fileUploadSessions.findOneBy("file_id", upload.file_id)?.completed).toBe(false);
  });

  it("deduplicates resolved file share channels", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;

    const uploadRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ filename: "dedupe.txt", length: 6 }),
    });
    const upload = (await uploadRes.json()) as any;
    await app.request(upload.upload_url, { method: "POST", body: "dedupe" });

    const completeRes = await app.request(`${base}/api/files.completeUploadExternal`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        files: [{ id: upload.file_id, title: "Dedupe" }],
        channel_id: channel,
        channels: "general",
      }),
    });
    const completed = (await completeRes.json()) as any;
    expect(completed.ok).toBe(true);

    const ss = getSlackStore(store);
    const messages = ss.messages.findBy("channel_id", channel);
    const file = ss.files.findOneBy("file_id", upload.file_id)!;
    expect(messages).toHaveLength(1);
    expect(file.shares.public?.[channel]).toHaveLength(1);
  });

  it("enforces file scopes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-files-read-token", { login: "U000000001", id: 1, scopes: ["files:read"] });

    const uploadRes = await app.request(`${base}/api/files.getUploadURLExternal`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-files-read-token", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "blocked.txt", length: 3 }),
    });
    const upload = (await uploadRes.json()) as any;
    expect(upload.ok).toBe(false);
    expect(upload.error).toBe("missing_scope");
    expect(upload.needed).toBe("files:write");
  });
});

describe("Slack plugin - pins and bookmarks", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function postPinnedMessage(channel: string, text = "pin me") {
    const res = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text }),
    });
    return (await res.json()) as any;
  }

  it("adds, lists, and removes message pins", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const posted = await postPinnedMessage(channel, "Pinned route message");

    const addRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect((await addRes.json()) as any).toMatchObject({ ok: true });

    const duplicateRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect(((await duplicateRes.json()) as any).error).toBe("already_pinned");

    const listRes = await app.request(`${base}/api/pins.list?channel=${channel}`, {
      method: "GET",
      headers: { Authorization: "Bearer xoxb-test-token" },
    });
    const listed = (await listRes.json()) as any;
    expect(listed.ok).toBe(true);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      type: "message",
      channel,
      message: {
        text: "Pinned route message",
        pinned_to: [channel],
      },
    });
    expect(listed.items[0].message.permalink).toContain(`/archives/${channel}/p`);

    const removeRes = await app.request(`${base}/api/pins.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect((await removeRes.json()) as any).toMatchObject({ ok: true });

    const removedListRes = await app.request(`${base}/api/pins.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    expect(((await removedListRes.json()) as any).items).toEqual([]);
  });

  it("rejects pin and bookmark mutations on archived channels", async () => {
    const ss = getSlackStore(store);
    const createRes = await app.request(`${base}/api/conversations.create`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "archived-pin-bookmark" }),
    });
    const channel = ((await createRes.json()) as any).channel.id;
    const posted = await postPinnedMessage(channel, "archived pin target");

    const pinAddRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect((await pinAddRes.json()) as any).toMatchObject({ ok: true });

    const bookmarkAddRes = await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        title: "Archived Runbook",
        type: "link",
        link: "https://example.com/archived",
      }),
    });
    const bookmark = (await bookmarkAddRes.json()) as any;
    expect(bookmark.ok).toBe(true);

    const archiveRes = await app.request(`${base}/api/conversations.archive`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    expect((await archiveRes.json()) as any).toMatchObject({ ok: true });

    const pinRemoveRes = await app.request(`${base}/api/pins.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect((await pinRemoveRes.json()) as any).toMatchObject({ ok: false, error: "is_archived" });
    expect(ss.pins.findBy("message_ts", posted.ts)).toHaveLength(1);

    const bookmarkEditRes = await app.request(`${base}/api/bookmarks.edit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel, bookmark_id: bookmark.bookmark.id, title: "Edited" }),
    });
    expect((await bookmarkEditRes.json()) as any).toMatchObject({ ok: false, error: "is_archived" });
    expect(ss.bookmarks.findOneBy("bookmark_id", bookmark.bookmark.id)?.title).toBe("Archived Runbook");

    const bookmarkRemoveRes = await app.request(`${base}/api/bookmarks.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel, bookmark_id: bookmark.bookmark.id }),
    });
    expect((await bookmarkRemoveRes.json()) as any).toMatchObject({ ok: false, error: "is_archived" });
    expect(ss.bookmarks.findOneBy("bookmark_id", bookmark.bookmark.id)).toBeDefined();
  });

  it("removes message pins when the backing message is deleted", async () => {
    const ss = getSlackStore(store);
    const channel = ss.channels.findOneBy("name", "general")!.channel_id;
    const posted = await postPinnedMessage(channel, "Pinned then deleted");

    const addRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    expect((await addRes.json()) as any).toMatchObject({ ok: true });

    const deleteRes = await app.request(`${base}/api/chat.delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, ts: posted.ts }),
    });
    expect((await deleteRes.json()) as any).toMatchObject({ ok: true });
    expect(ss.pins.findBy("message_ts", posted.ts)).toEqual([]);

    const listRes = await app.request(`${base}/api/pins.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel }),
    });
    const listed = (await listRes.json()) as any;
    expect(listed.ok).toBe(true);
    expect(listed.items).toEqual([]);
  });

  it("removes orphaned pin records without rendering them in the inspector", async () => {
    const ss = getSlackStore(store);
    const channel = ss.channels.findOneBy("name", "general")!.channel_id;
    const timestamp = "1234567890.123456";
    ss.pins.insert({
      pin_id: "P000ORPHAN",
      team_id: "T000000001",
      channel_id: channel,
      message_ts: timestamp,
      created: 1234567890,
      created_by: "U000000001",
    });

    const inspectorRes = await app.request(`${base}/?channel=${channel}`);
    const html = await inspectorRes.text();
    expect(html).not.toContain(timestamp);

    const removeRes = await app.request(`${base}/api/pins.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, timestamp }),
    });
    expect((await removeRes.json()) as any).toMatchObject({ ok: true });
    expect(ss.pins.findBy("message_ts", timestamp)).toEqual([]);
  });

  it("adds, edits, lists, and removes link bookmarks", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;

    const addRes = await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        title: "Runbook",
        type: "link",
        link: "https://example.com/runbook",
        emoji: ":book:",
      }),
    });
    const added = (await addRes.json()) as any;
    expect(added.ok).toBe(true);
    expect(added.bookmark).toMatchObject({
      channel_id: channel,
      title: "Runbook",
      type: "link",
      link: "https://example.com/runbook",
      emoji: ":book:",
    });

    const editRes = await app.request(`${base}/api/bookmarks.edit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        bookmark_id: added.bookmark.id,
        title: "Updated Runbook",
        link: "https://example.com/updated",
      }),
    });
    const edited = (await editRes.json()) as any;
    expect(edited.ok).toBe(true);
    expect(edited.bookmark.title).toBe("Updated Runbook");
    expect(edited.bookmark.date_updated).toBeGreaterThan(0);

    const listRes = await app.request(`${base}/api/bookmarks.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel }),
    });
    const listed = (await listRes.json()) as any;
    expect(listed.ok).toBe(true);
    expect(listed.bookmarks.map((bookmark: any) => bookmark.id)).toEqual([added.bookmark.id]);

    const removeRes = await app.request(`${base}/api/bookmarks.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel, bookmark_id: added.bookmark.id }),
    });
    expect((await removeRes.json()) as any).toMatchObject({ ok: true });

    const removedListRes = await app.request(`${base}/api/bookmarks.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel }),
    });
    expect(((await removedListRes.json()) as any).bookmarks).toEqual([]);
  });

  it("orders bookmarks deterministically by rank", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const addBookmark = async (title: string) => {
      const res = await app.request(`${base}/api/bookmarks.add`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          channel_id: channel,
          title,
          type: "link",
          link: `https://example.com/${encodeURIComponent(title)}`,
        }),
      });
      return (await res.json()) as any;
    };

    const first = await addBookmark("Ranked Bookmark A");
    const second = await addBookmark("Ranked Bookmark B");
    const third = await addBookmark("Ranked Bookmark C");
    expect([first.bookmark.rank, second.bookmark.rank, third.bookmark.rank]).toEqual(["1", "2", "3"]);

    await app.request(`${base}/api/bookmarks.remove`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel, bookmark_id: second.bookmark.id }),
    });
    const fourth = await addBookmark("Ranked Bookmark D");
    expect(fourth.bookmark.rank).toBe("4");

    const listRes = await app.request(`${base}/api/bookmarks.list`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel_id: channel }),
    });
    const listed = (await listRes.json()) as any;
    expect(listed.bookmarks.map((bookmark: any) => bookmark.title)).toEqual([
      "Ranked Bookmark A",
      "Ranked Bookmark C",
      "Ranked Bookmark D",
    ]);

    const inspectorRes = await app.request(`${base}/?channel=${channel}`);
    const html = await inspectorRes.text();
    expect(html.indexOf("Ranked Bookmark A")).toBeLessThan(html.indexOf("Ranked Bookmark C"));
    expect(html.indexOf("Ranked Bookmark C")).toBeLessThan(html.indexOf("Ranked Bookmark D"));
  });

  it("rejects invalid bookmark links", async () => {
    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;

    const invalidAddRes = await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        title: "Invalid Runbook",
        type: "link",
        link: "ftp://example.com/runbook",
      }),
    });
    expect(((await invalidAddRes.json()) as any).error).toBe("invalid_link");

    const addRes = await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        title: "Runbook",
        type: "link",
        link: "https://example.com/runbook",
      }),
    });
    const added = (await addRes.json()) as any;
    expect(added.ok).toBe(true);

    const invalidEditRes = await app.request(`${base}/api/bookmarks.edit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: channel,
        bookmark_id: added.bookmark.id,
        link: "javascript:alert(1)",
      }),
    });
    expect(((await invalidEditRes.json()) as any).error).toBe("invalid_link");
  });

  it("enforces private channel access for pins and bookmarks", async () => {
    const ss = getSlackStore(store);
    insertSlackTestUser(store, "U000000002", "pin-bookmark-outsider");
    tokenMap.set("xoxb-pin-bookmark-outsider-token", {
      login: "U000000002",
      id: 2,
      scopes: ["pins:read", "pins:write", "bookmarks:read", "bookmarks:write"],
    });

    const privateChannel = ss.channels.insert({
      channel_id: "G000000555",
      team_id: "T000000001",
      name: "pin-bookmark-private",
      is_channel: false,
      is_private: true,
      is_archived: false,
      topic: { value: "", creator: "U000000001", last_set: 0 },
      purpose: { value: "", creator: "U000000001", last_set: 0 },
      members: ["U000000001"],
      creator: "U000000001",
      num_members: 1,
    });
    const posted = await postPinnedMessage(privateChannel.channel_id, "private pin");

    const pinRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-pin-bookmark-outsider-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: privateChannel.channel_id, timestamp: posted.ts }),
    });
    expect(((await pinRes.json()) as any).error).toBe("not_in_channel");

    const bookmarkRes = await app.request(`${base}/api/bookmarks.list`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-pin-bookmark-outsider-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel_id: privateChannel.channel_id }),
    });
    expect(((await bookmarkRes.json()) as any).error).toBe("not_in_channel");
  });

  it("enforces pin and bookmark scopes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-pins-read-token", { login: "U000000001", id: 1, scopes: ["pins:read"] });
    tokenMap.set("xoxb-bookmarks-read-token", { login: "U000000001", id: 1, scopes: ["bookmarks:read"] });

    const channel = getSlackStore(store).channels.findOneBy("name", "general")!.channel_id;
    const posted = await postPinnedMessage(channel, "strict pin");

    const pinRes = await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-pins-read-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp: posted.ts }),
    });
    const pin = (await pinRes.json()) as any;
    expect(pin.ok).toBe(false);
    expect(pin.error).toBe("missing_scope");
    expect(pin.needed).toBe("pins:write");

    const bookmarkRes = await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-bookmarks-read-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channel,
        title: "Strict Bookmark",
        type: "link",
        link: "https://example.com/strict",
      }),
    });
    const bookmark = (await bookmarkRes.json()) as any;
    expect(bookmark.ok).toBe(false);
    expect(bookmark.error).toBe("missing_scope");
    expect(bookmark.needed).toBe("bookmarks:write");
  });
});

describe("Slack plugin - views", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createTestApp());
  });

  it("publishes and updates App Home views", async () => {
    const blocks = [{ type: "section", text: { type: "plain_text", text: "Home view from route test" } }];

    const publishRes = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        view: {
          type: "home",
          blocks,
          callback_id: "home_callback",
          external_id: "home-route-test",
          private_metadata: "home-metadata",
        },
      }),
    });
    const published = (await publishRes.json()) as any;
    expect(published.ok).toBe(true);
    expect(published.view).toMatchObject({
      type: "home",
      blocks,
      callback_id: "home_callback",
      external_id: "home-route-test",
      private_metadata: "home-metadata",
    });
    expect(published.view.id).toMatch(/^V/);
    expect(published.view.root_view_id).toBe(published.view.id);
    expect(getSlackStore(store).views.all()).toHaveLength(1);

    const updateRes = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        hash: published.view.hash,
        view: {
          type: "home",
          blocks: [{ type: "section", text: { type: "plain_text", text: "Updated App Home" } }],
          external_id: "home-route-test",
        },
      }),
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.ok).toBe(true);
    expect(updated.view.id).toBe(published.view.id);
    expect(updated.view.hash).not.toBe(published.view.hash);
    expect(getSlackStore(store).views.all()).toHaveLength(1);

    const inspector = await app.request(`${base}/`);
    const html = await inspector.text();
    expect(html).toContain("App Home");
    expect(html).toContain("Updated App Home");
  });

  it("opens, updates, and pushes modal views", async () => {
    const triggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const trigger = (await triggerRes.json()) as any;
    expect(trigger.ok).toBe(true);
    expect(trigger.trigger_id).toBeDefined();

    const openRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: trigger.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Route Modal" },
          close: { type: "plain_text", text: "Close" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Opened modal" } }],
          callback_id: "route_modal",
          external_id: "route-modal-open",
        },
      }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(opened.view.type).toBe("modal");
    expect(opened.view.root_view_id).toBe(opened.view.id);
    expect(opened.view.previous_view_id).toBeNull();

    const updateRes = await app.request(`${base}/api/views.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        view_id: opened.view.id,
        hash: opened.view.hash,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Updated Route Modal" },
          blocks: [{ type: "section", text: { type: "plain_text", text: "Updated modal body" } }],
          external_id: "route-modal-open",
        },
      }),
    });
    const updated = (await updateRes.json()) as any;
    expect(updated.ok).toBe(true);
    expect(updated.view.id).toBe(opened.view.id);
    expect(updated.view.hash).not.toBe(opened.view.hash);
    expect(updated.view.blocks[0].text.text).toBe("Updated modal body");

    const pushTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: opened.view.id }),
    });
    const pushTrigger = (await pushTriggerRes.json()) as any;
    expect(pushTrigger.ok).toBe(true);

    const pushRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: pushTrigger.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Pushed Route Modal" },
          blocks: [{ type: "section", text: { type: "plain_text", text: "Pushed modal body" } }],
          external_id: "route-modal-pushed",
        },
      }),
    });
    const pushed = (await pushRes.json()) as any;
    expect(pushed.ok).toBe(true);
    expect(pushed.view.previous_view_id).toBe(opened.view.id);
    expect(pushed.view.root_view_id).toBe(opened.view.id);
    expect(getSlackStore(store).views.findBy("user_id", "U000000001")).toHaveLength(2);

    const reusedTriggerRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: pushTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Reuse" }, blocks: [] },
      }),
    });
    expect(((await reusedTriggerRes.json()) as any).error).toBe("exchanged_trigger_id");
  });

  it("accepts interactivity pointers for modal opens and pushes", async () => {
    const openPointerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const openPointer = (await openPointerRes.json()) as any;
    expect(openPointer.ok).toBe(true);

    const openRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        interactivity_pointer: openPointer.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Pointer Modal" },
          blocks: [{ type: "section", text: { type: "plain_text", text: "Opened from pointer" } }],
        },
      }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);

    const pushPointerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: opened.view.id }),
    });
    const pushPointer = (await pushPointerRes.json()) as any;
    expect(pushPointer.ok).toBe(true);

    const pushRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        interactivity_pointer: pushPointer.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Pushed Pointer Modal" },
          blocks: [{ type: "section", text: { type: "plain_text", text: "Pushed from pointer" } }],
        },
      }),
    });
    const pushed = (await pushRes.json()) as any;
    expect(pushed.ok).toBe(true);
    expect(pushed.view.previous_view_id).toBe(opened.view.id);
    expect(pushed.view.root_view_id).toBe(opened.view.id);
  });

  it("requires valid unexpired trigger ids for modal opens", async () => {
    const view = {
      type: "modal",
      title: { type: "plain_text", text: "Trigger Modal" },
      blocks: [],
    };

    const missingRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view }),
    });
    expect(((await missingRes.json()) as any).error).toBe("invalid_trigger_id");

    const unknownRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ trigger_id: "12345.98765.unknown", view }),
    });
    expect(((await unknownRes.json()) as any).error).toBe("invalid_trigger_id");

    const triggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const trigger = (await triggerRes.json()) as any;
    const triggerRecord = getSlackStore(store).viewTriggers.findOneBy("trigger_id", trigger.trigger_id)!;
    getSlackStore(store).viewTriggers.update(triggerRecord.id, { expires_at: 0 });

    const expiredRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ trigger_id: trigger.trigger_id, view }),
    });
    expect(((await expiredRes.json()) as any).error).toBe("expired_trigger_id");
  });

  it("keeps modal triggers and updates scoped to their Slack app", async () => {
    const ss = getSlackStore(store);
    ss.tokens.insert({
      token: "xoxb-app-a-token",
      token_type: "bot",
      team_id: "T000000001",
      user_id: "U000000001",
      scopes: [],
      app_id: "A000000101",
      bot_id: "B000000101",
    });
    ss.tokens.insert({
      token: "xoxb-app-b-token",
      token_type: "bot",
      team_id: "T000000001",
      user_id: "U000000001",
      scopes: [],
      app_id: "A000000202",
      bot_id: "B000000202",
    });

    const appAHeaders = { Authorization: "Bearer xoxb-app-a-token", "Content-Type": "application/json" };
    const appBHeaders = { Authorization: "Bearer xoxb-app-b-token", "Content-Type": "application/json" };
    const view = {
      type: "modal",
      title: { type: "plain_text", text: "App A Modal" },
      blocks: [{ type: "section", text: { type: "plain_text", text: "Owned by app A" } }],
      external_id: "app-a-modal",
    };

    const triggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: appAHeaders,
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const trigger = (await triggerRes.json()) as any;

    const wrongAppOpenRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: appBHeaders,
      body: JSON.stringify({ trigger_id: trigger.trigger_id, view }),
    });
    expect(((await wrongAppOpenRes.json()) as any).error).toBe("invalid_trigger_id");

    const openRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: appAHeaders,
      body: JSON.stringify({ trigger_id: trigger.trigger_id, view }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(ss.views.findOneBy("view_id", opened.view.id)?.app_id).toBe("A000000101");

    const wrongAppUpdateRes = await app.request(`${base}/api/views.update`, {
      method: "POST",
      headers: appBHeaders,
      body: JSON.stringify({
        view_id: opened.view.id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Wrong App Update" },
          blocks: [],
        },
      }),
    });
    expect(((await wrongAppUpdateRes.json()) as any).error).toBe("not_found");
    expect(ss.views.findOneBy("view_id", opened.view.id)?.title?.text).toBe("App A Modal");

    const wrongAppTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: appBHeaders,
      body: JSON.stringify({ view_id: opened.view.id }),
    });
    expect(((await wrongAppTriggerRes.json()) as any).error).toBe("view_not_found");
  });

  it("canonicalizes the authenticated user when generating default modal triggers", async () => {
    tokenMap.set("xoxb-admin-name-token", { login: "admin", id: 99, scopes: [] });

    const triggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-admin-name-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const trigger = (await triggerRes.json()) as any;
    expect(trigger.ok).toBe(true);
    expect(getSlackStore(store).viewTriggers.findOneBy("trigger_id", trigger.trigger_id)?.user_id).toBe("U000000001");

    const openRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-admin-name-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        trigger_id: trigger.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Canonical User Modal" },
          blocks: [],
        },
      }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);
    expect(getSlackStore(store).views.findOneBy("view_id", opened.view.id)?.user_id).toBe("U000000001");
  });

  it("requires an existing modal stack and enforces the push limit", async () => {
    const looseTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const looseTrigger = (await looseTriggerRes.json()) as any;

    const noStackRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: looseTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "No Stack" }, blocks: [] },
      }),
    });
    expect(((await noStackRes.json()) as any).error).toBe("view_not_found");

    const openTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const openTrigger = (await openTriggerRes.json()) as any;
    const openRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: openTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Root" }, blocks: [] },
      }),
    });
    const opened = (await openRes.json()) as any;
    expect(opened.ok).toBe(true);

    const firstPushTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: opened.view.id }),
    });
    const firstPushTrigger = (await firstPushTriggerRes.json()) as any;
    const firstPushRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: firstPushTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Second" }, blocks: [] },
      }),
    });
    const firstPush = (await firstPushRes.json()) as any;
    expect(firstPush.ok).toBe(true);

    const secondPushTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: firstPush.view.id }),
    });
    const secondPushTrigger = (await secondPushTriggerRes.json()) as any;
    const secondPushRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: secondPushTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Third" }, blocks: [] },
      }),
    });
    const secondPush = (await secondPushRes.json()) as any;
    expect(secondPush.ok).toBe(true);

    const overLimitTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: secondPush.view.id }),
    });
    const overLimitTrigger = (await overLimitTriggerRes.json()) as any;
    const overLimitRes = await app.request(`${base}/api/views.push`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: overLimitTrigger.trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "Fourth" }, blocks: [] },
      }),
    });
    expect(((await overLimitRes.json()) as any).error).toBe("push_limit_reached");
  });

  it("matches Slack views methods having no strict scope requirement", async () => {
    store.setData("slack.strict_scopes", true);
    tokenMap.set("xoxb-views-no-scope-token", { login: "U000000001", id: 1, scopes: [] });

    const res = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-views-no-scope-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "U000000001",
        view: {
          type: "home",
          blocks: [{ type: "section", text: { type: "plain_text", text: "No view scopes required" } }],
        },
      }),
    });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("rejects invalid view payloads and stale hashes", async () => {
    const invalidRes = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        view: { type: "home", blocks: "not blocks" },
      }),
    });
    expect(((await invalidRes.json()) as any).error).toBe("invalid_view");

    const titleTriggerRes = await app.request(`${base}/api/views.generateTriggerId`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ user_id: "U000000001" }),
    });
    const titleTrigger = (await titleTriggerRes.json()) as any;
    const missingTitleRes = await app.request(`${base}/api/views.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        trigger_id: titleTrigger.trigger_id,
        view: { type: "modal", blocks: [] },
      }),
    });
    expect(((await missingTitleRes.json()) as any).error).toBe("invalid_view");

    const publishRes = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        view: { type: "home", blocks: [] },
      }),
    });
    const published = (await publishRes.json()) as any;
    expect(published.ok).toBe(true);

    const missingUpdateRes = await app.request(`${base}/api/views.update`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        view_id: "VNOPE",
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Missing" },
          blocks: [],
        },
      }),
    });
    expect(((await missingUpdateRes.json()) as any).error).toBe("not_found");

    const staleRes = await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        hash: "stale-hash",
        view: { type: "home", blocks: [] },
      }),
    });
    expect(((await staleRes.json()) as any).error).toBe("hash_conflict");
  });
});

describe("Slack plugin - Message Inspector", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let webhooks: WebhookDispatcher;

  beforeEach(() => {
    ({ app, store, webhooks } = createTestApp());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("shows message reactions in the inspector", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "Inspector reaction message" }),
    });
    const posted = (await postRes.json()) as any;

    await app.request(`${base}/api/reactions.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts, name: "wave" }),
    });

    const res = await app.request(`${base}/?channel=${ch.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reactions");
    expect(html).toContain(":wave: 1");
  });

  it("shows pins and bookmarks in the inspector", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];

    const postRes = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, text: "Inspector pinned message" }),
    });
    const posted = (await postRes.json()) as any;

    await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: posted.ts }),
    });
    await app.request(`${base}/api/bookmarks.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel_id: ch.channel_id,
        title: "Inspector Bookmark",
        type: "link",
        link: "https://example.com/inspector",
      }),
    });

    const res = await app.request(`${base}/?channel=${ch.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pins");
    expect(html).toContain("Inspector pinned message");
    expect(html).toContain("Bookmarks");
    expect(html).toContain("Inspector Bookmark");
  });

  it("shows pinned messages outside the recent message slice in the inspector", async () => {
    const ss = getSlackStore(store);
    const ch = ss.channels.all()[0];
    const pinnedTs = "1000000000.000001";
    ss.messages.insert({
      ts: pinnedTs,
      channel_id: ch.channel_id,
      user: "U000000001",
      text: "Inspector old pinned message",
      type: "message" as const,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });
    await app.request(`${base}/api/pins.add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: ch.channel_id, timestamp: pinnedTs }),
    });

    for (let index = 0; index < 55; index++) {
      ss.messages.insert({
        ts: `1000000${String(index + 1).padStart(3, "0")}.000001`,
        channel_id: ch.channel_id,
        user: "U000000001",
        text: `Recent inspector message ${index}`,
        type: "message" as const,
        reply_count: 0,
        reply_users: [],
        reactions: [],
      });
    }

    const res = await app.request(`${base}/?channel=${ch.channel_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pins");
    expect(html).toContain("Inspector old pinned message");
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

  it("shows channels and DMs in the inspector", async () => {
    insertSlackTestUser(store, "U000000222", "inspector-peer");

    const openRes = await app.request(`${base}/api/conversations.open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ users: "U000000222", return_im: true }),
    });
    const opened = (await openRes.json()) as any;
    await app.request(`${base}/api/conversations.close`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: opened.channel.id }),
    });

    const res = await app.request(`${base}/?tab=channels`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Channels");
    expect(html).toContain("Direct Messages");
    expect(html).toContain("inspector-peer");
    expect(html).toContain("DM");
    expect(html).toContain(">closed<");
    expect(html).not.toContain("<td>U000000001</td>");
  });

  it("shows files, views, auth state, and event deliveries in inspector tabs", async () => {
    const ss = getSlackStore(store);
    const channel = ss.channels.findOneBy("name", "general")!.channel_id;
    ss.files.insert({
      file_id: "FINSPECT001",
      team_id: "T000000001",
      user: "U000000001",
      name: "inspector-file.txt",
      title: "Inspector File",
      mimetype: "text/plain",
      filetype: "text",
      pretty_type: "Text",
      mode: "hosted",
      size: 14,
      created: Math.floor(Date.now() / 1000),
      timestamp: Math.floor(Date.now() / 1000),
      url_private: `${base}/files-pri/FINSPECT001/inspector-file.txt`,
      url_private_download: `${base}/files-pri/FINSPECT001/inspector-file.txt`,
      permalink: `${base}/files/FINSPECT001`,
      is_external: false,
      external_type: "",
      is_public: false,
      public_url_shared: false,
      display_as_bot: false,
      editable: false,
      deleted: false,
      channels: [channel],
      groups: [],
      ims: [],
      shares: {},
    });
    ss.tokens.insert({
      token: "xoxb-inspector-token",
      token_type: "bot",
      team_id: "T000000001",
      user_id: "U000000001",
      scopes: ["chat:write", "files:read"],
      app_id: "AINSPECT001",
      bot_id: "BINSPECT001",
    });

    await app.request(`${base}/api/views.publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        user_id: "U000000001",
        view: {
          type: "home",
          blocks: [{ type: "section", text: { type: "plain_text", text: "Inspector App Home" } }],
        },
      }),
    });

    captureFetchRequests(500);
    registerSlackEventSubscription(webhooks, ["message"]);
    await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, text: "Inspector event delivery" }),
    });
    captureFetchRequests(200);
    for (let index = 0; index < 100; index++) {
      await app.request(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ channel, text: `Inspector success event delivery ${index}` }),
      });
    }

    const files = await app.request(`${base}/?tab=files`);
    expect(await files.text()).toContain("Inspector File");

    const views = await app.request(`${base}/?tab=views`);
    expect(await views.text()).toContain("Inspector App Home");

    const auth = await app.request(`${base}/?tab=auth`);
    const authHtml = await auth.text();
    expect(authHtml).toContain("Tokens");
    expect(authHtml).toContain("xoxb-ins...oken");
    expect(authHtml).toContain("Incoming Webhooks");

    const events = await app.request(`${base}/?tab=events`);
    const eventsHtml = await events.text();
    expect(eventsHtml).toContain("Event Deliveries");
    expect(eventsHtml).toContain("message");
    expect(eventsHtml).toContain("500");
    expect(eventsHtml).toContain("Last Errors");
  });
});
