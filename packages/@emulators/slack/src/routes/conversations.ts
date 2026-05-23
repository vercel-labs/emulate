import type { RouteContext } from "@emulators/core";
import type { SlackChannel, SlackMessage, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import { formatSlackMessage, generateSlackId, generateTs, parseSlackBody, slackError, slackOk } from "../helpers.js";

export function conversationsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const isChannelMember = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  const dispatchConversationEvent = async (type: string, event: Record<string, unknown>) => {
    await webhooks.dispatch(
      type,
      undefined,
      {
        type: "event_callback",
        event: { type, ...event },
      },
      "slack",
    );
  };
  const insertAndDispatchMessageEvent = async (
    channel: SlackChannel,
    user: string,
    message: Pick<SlackMessage, "subtype" | "text"> &
      Partial<Pick<SlackMessage, "topic" | "purpose" | "old_name" | "name">>,
  ) => {
    const msg = ss().messages.insert({
      ts: generateTs(),
      channel_id: channel.channel_id,
      user,
      type: "message" as const,
      ...message,
      reply_count: 0,
      reply_users: [],
      reactions: [],
    });

    await webhooks.dispatch(
      "message",
      undefined,
      {
        type: "event_callback",
        event: {
          ...formatSlackMessage(msg),
          channel: channel.channel_id,
          event_ts: msg.ts,
        },
      },
      "slack",
    );
    return msg;
  };

  // conversations.list
  app.post("/api/conversations.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";
    const excludeArchived = isTruthySlackBoolean(body.exclude_archived);

    const allChannels = ss()
      .channels.all()
      .filter((ch) => !excludeArchived || !ch.is_archived);

    // Simple cursor pagination using channel id
    let startIndex = 0;
    if (cursor) {
      const idx = allChannels.findIndex((ch) => ch.channel_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allChannels.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allChannels.length ? allChannels[startIndex + limit].channel_id : "";

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
    const name = normalizeChannelName(typeof body.name === "string" ? body.name : "");
    const isPrivate = body.is_private === true || body.is_private === "true";

    if (!name) return slackError(c, "invalid_name_specials");
    const nameError = validateChannelName(name);
    if (nameError) return slackError(c, nameError);

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

  // conversations.archive
  app.post("/api/conversations.archive", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (isGeneralChannel(ch)) return slackError(c, "cant_archive_general");
    if (ch.is_archived) return slackError(c, "already_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const updated = ss().channels.update(ch.id, { is_archived: true })!;
    await dispatchConversationEvent(lifecycleEventType(updated, "archive"), {
      channel: updated.channel_id,
      user: authUserId,
    });
    await insertAndDispatchMessageEvent(updated, authUserId, {
      subtype: lifecycleEventType(updated, "archive"),
      text: `<@${authUserId}> archived the ${conversationNoun(updated)}`,
    });

    return slackOk(c, {});
  });

  // conversations.unarchive
  app.post("/api/conversations.unarchive", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (!ch.is_archived) return slackError(c, "not_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    const members = isChannelMember(ch, authSlackUser, authUserId) ? ch.members : [...ch.members, authUserId];
    const updated = ss().channels.update(ch.id, {
      is_archived: false,
      members,
      num_members: members.length,
    })!;

    await dispatchConversationEvent(lifecycleEventType(updated, "unarchive"), {
      channel: updated.channel_id,
      user: authUserId,
    });
    await insertAndDispatchMessageEvent(updated, authUserId, {
      subtype: lifecycleEventType(updated, "unarchive"),
      text: `<@${authUserId}> unarchived the ${conversationNoun(updated)}`,
    });

    return slackOk(c, {});
  });

  // conversations.rename
  app.post("/api/conversations.rename", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const name = normalizeChannelName(typeof body.name === "string" ? body.name : "");
    if (!channel) return slackError(c, "channel_not_found");

    const nameError = validateChannelName(name);
    if (nameError) return slackError(c, nameError);

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");
    if (ch.creator !== authUserId && ch.creator !== authUser.login && !authSlackUser?.is_admin) {
      return slackError(c, "not_authorized");
    }

    const existing = ss().channels.findOneBy("name", name);
    if (existing && existing.id !== ch.id) return slackError(c, "name_taken");
    if (name === ch.name) return slackOk(c, { channel: formatChannel(ch) });

    const oldName = ch.name;
    const updated = ss().channels.update(ch.id, { name })!;
    await dispatchConversationEvent(lifecycleEventType(updated, "rename"), {
      channel: {
        id: updated.channel_id,
        name: updated.name,
        created: createdSeconds(updated),
      },
    });
    await insertAndDispatchMessageEvent(updated, authUserId, {
      subtype: lifecycleMessageSubtype(updated, "name"),
      text: `<@${authUserId}> renamed the ${conversationNoun(updated)} from "${oldName}" to "${updated.name}"`,
      old_name: oldName,
      name: updated.name,
    });

    return slackOk(c, { channel: formatChannel(updated) });
  });

  // conversations.setTopic
  app.post("/api/conversations.setTopic", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const topic = typeof body.topic === "string" ? body.topic : undefined;
    if (!channel) return slackError(c, "channel_not_found");
    if (topic === undefined) return slackError(c, "invalid_arguments");
    if (topic.length > 250) return slackError(c, "too_long");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const now = Math.floor(Date.now() / 1000);
    const updated = ss().channels.update(ch.id, {
      topic: { value: topic, creator: authUserId, last_set: now },
    })!;

    await insertAndDispatchMessageEvent(updated, authUserId, {
      subtype: lifecycleMessageSubtype(updated, "topic"),
      text: `<@${authUserId}> set the ${conversationNoun(updated)} topic: ${topic}`,
      topic,
    });

    return slackOk(c, { channel: formatChannel(updated) });
  });

  // conversations.setPurpose
  app.post("/api/conversations.setPurpose", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const purpose = typeof body.purpose === "string" ? body.purpose : undefined;
    if (!channel) return slackError(c, "channel_not_found");
    if (purpose === undefined) return slackError(c, "invalid_arguments");
    if (purpose.length > 250) return slackError(c, "too_long");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    if (ch.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const now = Math.floor(Date.now() / 1000);
    const updated = ss().channels.update(ch.id, {
      purpose: { value: purpose, creator: authUserId, last_set: now },
    })!;

    await insertAndDispatchMessageEvent(updated, authUserId, {
      subtype: lifecycleMessageSubtype(updated, "purpose"),
      text: `<@${authUserId}> set the ${conversationNoun(updated)} purpose: ${purpose}`,
      purpose,
    });

    return slackOk(c, { purpose, channel: formatChannel(updated) });
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
    const allMessages = ss()
      .messages.findBy("channel_id", channel)
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
      messages: page.map(formatSlackMessage),
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

    const allMessages = ss()
      .messages.findBy("channel_id", channel)
      .filter((m) => m.ts === ts || m.thread_ts === ts)
      .sort((a, b) => (a.ts > b.ts ? 1 : -1));

    return slackOk(c, {
      messages: allMessages.map(formatSlackMessage),
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

function formatChannel(ch: SlackChannel) {
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
    created: createdSeconds(ch),
  };
}

function createdSeconds(ch: SlackChannel): number {
  return Math.floor(new Date(ch.created_at).getTime() / 1000);
}

function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function validateChannelName(name: string): string | undefined {
  if (!name) return "invalid_name_required";
  if (name.length > 80) return "invalid_name_maxlength";
  if (!/[a-z0-9]/.test(name)) return "invalid_name_punctuation";
  if (!/^[a-z0-9_-]+$/.test(name)) return "invalid_name_specials";
  return undefined;
}

function isTruthySlackBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1";
}

function isGeneralChannel(ch: SlackChannel): boolean {
  return ch.channel_id === "C000000001" || ch.name === "general";
}

function lifecycleEventType(ch: SlackChannel, action: "archive" | "rename" | "unarchive"): string {
  return `${conversationEventPrefix(ch)}_${action}`;
}

function lifecycleMessageSubtype(ch: SlackChannel, action: "name" | "purpose" | "topic"): string {
  return `${conversationEventPrefix(ch)}_${action}`;
}

function conversationEventPrefix(ch: SlackChannel): "channel" | "group" {
  return ch.is_private ? "group" : "channel";
}

function conversationNoun(ch: SlackChannel): "channel" | "group" {
  return ch.is_private ? "group" : "channel";
}
