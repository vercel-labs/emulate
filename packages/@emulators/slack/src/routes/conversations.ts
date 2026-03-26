import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { generateSlackId, slackOk, slackError, parseSlackBody } from "../helpers.js";

export function conversationsRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // conversations.list
  app.post("/api/conversations.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";

    const allChannels = ss().channels.all().filter((ch) => !ch.is_archived);

    // Simple cursor pagination using channel id
    let startIndex = 0;
    if (cursor) {
      const idx = allChannels.findIndex((ch) => ch.channel_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allChannels.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allChannels.length
      ? allChannels[startIndex + limit].channel_id
      : "";

    return slackOk(c, {
      channels: page.map(formatChannel),
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // conversations.info
  app.post("/api/conversations.info", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    return slackOk(c, { channel: formatChannel(ch) });
  });

  // conversations.create
  app.post("/api/conversations.create", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const name = typeof body.name === "string" ? body.name : "";
    const isPrivate = body.is_private === true || body.is_private === "true";

    if (!name) return slackError(c, "invalid_name_specials");

    // Check for duplicate name
    const existing = ss().channels.findOneBy("name", name);
    if (existing) return slackError(c, "name_taken");

    const team = ss().teams.all()[0];
    const channelId = generateSlackId("C");
    const now = Math.floor(Date.now() / 1000);

    const ch = ss().channels.insert({
      channel_id: channelId,
      team_id: team?.team_id ?? "T000000001",
      name,
      is_channel: !isPrivate,
      is_private: isPrivate,
      is_archived: false,
      topic: { value: "", creator: "", last_set: 0 },
      purpose: { value: "", creator: authUser.login, last_set: now },
      members: [authUser.login],
      creator: authUser.login,
      num_members: 1,
    });

    return slackOk(c, { channel: formatChannel(ch) });
  });

  // conversations.history
  app.post("/api/conversations.history", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";

    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    // Get top-level messages (no thread_ts or thread_ts === ts)
    const allMessages = ss().messages
      .findBy("channel_id", channel)
      .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1));

    let startIndex = 0;
    if (cursor) {
      const idx = allMessages.findIndex((m) => m.ts === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allMessages.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allMessages.length;
    const nextCursor = hasMore ? allMessages[startIndex + limit].ts : "";

    return slackOk(c, {
      messages: page.map(formatMessage),
      has_more: hasMore,
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // conversations.replies
  app.post("/api/conversations.replies", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";

    if (!channel || !ts) return slackError(c, "channel_not_found");

    const allMessages = ss().messages
      .findBy("channel_id", channel)
      .filter((m) => m.ts === ts || m.thread_ts === ts)
      .sort((a, b) => (a.ts > b.ts ? 1 : -1));

    return slackOk(c, {
      messages: allMessages.map(formatMessage),
      has_more: false,
    });
  });

  // conversations.join
  app.post("/api/conversations.join", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    if (!ch.members.includes(authUser.login)) {
      ss().channels.update(ch.id, {
        members: [...ch.members, authUser.login],
        num_members: ch.num_members + 1,
      });
    }

    const updated = ss().channels.findOneBy("channel_id", channel)!;
    return slackOk(c, { channel: formatChannel(updated) });
  });

  // conversations.leave
  app.post("/api/conversations.leave", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    if (ch.members.includes(authUser.login)) {
      ss().channels.update(ch.id, {
        members: ch.members.filter((m) => m !== authUser.login),
        num_members: Math.max(0, ch.num_members - 1),
      });
    }

    return slackOk(c, {});
  });

  // conversations.members
  app.post("/api/conversations.members", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");

    return slackOk(c, {
      members: ch.members,
      response_metadata: { next_cursor: "" },
    });
  });
}

function formatChannel(ch: {
  channel_id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  creator: string;
  num_members: number;
  created_at: string;
}) {
  return {
    id: ch.channel_id,
    name: ch.name,
    is_channel: ch.is_channel,
    is_private: ch.is_private,
    is_archived: ch.is_archived,
    topic: ch.topic,
    purpose: ch.purpose,
    creator: ch.creator,
    num_members: ch.num_members,
    created: Math.floor(new Date(ch.created_at).getTime() / 1000),
  };
}

function formatMessage(msg: {
  ts: string;
  user: string;
  text: string;
  type: string;
  subtype?: string;
  thread_ts?: string;
  reply_count: number;
  reply_users: string[];
  reactions: Array<{ name: string; users: string[]; count: number }>;
}) {
  return {
    type: msg.type,
    user: msg.user,
    text: msg.text,
    ts: msg.ts,
    ...(msg.subtype ? { subtype: msg.subtype } : {}),
    ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
    ...(msg.reply_count > 0 ? { reply_count: msg.reply_count, reply_users: msg.reply_users } : {}),
    ...(msg.reactions.length > 0 ? { reactions: msg.reactions } : {}),
  };
}
