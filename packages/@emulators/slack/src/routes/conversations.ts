import type { RouteContext } from "@emulators/core";
import type { SlackChannel, SlackFile, SlackFileShare, SlackMessage, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackMessage,
  generateSlackId,
  generateTs,
  getSlackConversationOpenState,
  parseSlackBody,
  requireSlackScopes,
  setSlackConversationOpenState,
  slackConversationHistoryScope,
  slackConversationJoinScope,
  slackConversationReadScope,
  slackConversationWriteScope,
  slackError,
  slackOk,
} from "../helpers.js";

export function conversationsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const memberAliases = (user: SlackUser | undefined, userId: string) =>
    new Set([userId, user?.name].filter((value): value is string => Boolean(value)));
  const getChannelMemberKey = (channel: SlackChannel, user: SlackUser | undefined, userId: string) => {
    const aliases = memberAliases(user, userId);
    return channel.members.find((member) => aliases.has(member));
  };
  const isChannelMember = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    getChannelMemberKey(channel, user, userId) !== undefined;
  const canReadConversation = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    !channel.is_private || isChannelMember(channel, user, userId);
  const visibleFileChannelIds = (file: SlackFile, authUser: { login: string }) => {
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = authSlackUser?.user_id ?? authUser.login;
    return fileChannels(file).filter((channelId) => {
      const channel = ss().channels.findOneBy("channel_id", channelId);
      return channel ? canReadConversation(channel, authSlackUser, authUserId) : false;
    });
  };
  const visibleFileForAuth = (file: SlackFile, authUser: { login: string }): SlackFile => {
    const visibleIds = new Set(visibleFileChannelIds(file, authUser));
    const publicShares = filterVisibleShares(file.shares.public, visibleIds);
    const privateShares = filterVisibleShares(file.shares.private, visibleIds);
    const shares: SlackFile["shares"] = {};
    if (publicShares) shares.public = publicShares;
    if (privateShares) shares.private = privateShares;

    return {
      ...file,
      channels: file.channels.filter((channelId) => visibleIds.has(channelId)),
      groups: file.groups.filter((channelId) => visibleIds.has(channelId)),
      ims: file.ims.filter((channelId) => visibleIds.has(channelId)),
      shares,
    };
  };
  const formatSlackMessageForAuth = (msg: SlackMessage, authUser: { login: string }) =>
    formatSlackMessage({
      ...msg,
      ...(msg.files
        ? {
            files: msg.files
              .map((file) => ss().files.findOneBy("file_id", file.file_id) ?? file)
              .filter((file) => !file.deleted)
              .map((file) => visibleFileForAuth(file, authUser)),
          }
        : {}),
    });
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
  const dispatchMemberJoined = async (channel: SlackChannel, user: string, inviter?: string) => {
    await dispatchConversationEvent("member_joined_channel", {
      user,
      channel: channel.channel_id,
      channel_type: channelTypeLetter(channel),
      team: channel.team_id,
      ...(inviter ? { inviter } : {}),
    });
  };
  const dispatchMemberLeft = async (channel: SlackChannel, user: string) => {
    await dispatchConversationEvent("member_left_channel", {
      user,
      channel: channel.channel_id,
      channel_type: channelTypeLetter(channel),
      team: channel.team_id,
    });
  };

  // conversations.list
  app.post("/api/conversations.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";
    const excludeArchived = isTruthySlackBoolean(body.exclude_archived);
    const types = parseConversationTypes(body.types);
    const scopeError = requireSlackScopes(c, store, readScopesForConversationTypes(types));
    if (scopeError) return scopeError;
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);

    const allChannels = ss()
      .channels.all()
      .filter((ch) => matchesConversationTypes(ch, types))
      .filter((ch) => canReadConversation(ch, authSlackUser, authUserId))
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
      channels: page.map((ch) => formatChannel(ch, authUserId, authSlackUser?.name)),
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
    const scopeError = requireSlackScopes(c, store, [slackConversationReadScope(ch)]);
    if (scopeError) return scopeError;
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    return slackOk(c, { channel: formatChannel(ch, authUserId, authSlackUser?.name) });
  });

  // conversations.create
  app.post("/api/conversations.create", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const name = normalizeChannelName(typeof body.name === "string" ? body.name : "");
    const isPrivate = body.is_private === true || body.is_private === "true";
    const scopeError = requireSlackScopes(c, store, [
      isPrivate ? "groups:write" : ["channels:manage", "channels:write"],
    ]);
    if (scopeError) return scopeError;

    if (!name) return slackError(c, "invalid_name_specials");
    const nameError = validateChannelName(name);
    if (nameError) return slackError(c, nameError);

    const existing = findNamedChannel(ss().channels.all(), name);
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
      members: [getAuthUserId(authUser)],
      creator: getAuthUserId(authUser),
      num_members: 1,
    });

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    return slackOk(c, { channel: formatChannel(ch, authUserId, authSlackUser?.name) });
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
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (isDirectConversation(ch)) return slackError(c, "method_not_supported_for_channel_type");
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
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (isDirectConversation(ch)) return slackError(c, "method_not_supported_for_channel_type");
    if (!ch.is_archived) return slackError(c, "not_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    const isMember = isChannelMember(ch, authSlackUser, authUserId);
    if (ch.is_private && !isMember) return slackError(c, "not_in_channel");

    const members = isMember ? ch.members : [...ch.members, authUserId];
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
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (isDirectConversation(ch)) return slackError(c, "method_not_supported_for_channel_type");
    if (ch.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");
    if (ch.creator !== authUserId && ch.creator !== authUser.login && !authSlackUser?.is_admin) {
      return slackError(c, "not_authorized");
    }

    const existing = findNamedChannel(ss().channels.all(), name);
    if (existing && existing.id !== ch.id) return slackError(c, "name_taken");
    if (name === ch.name) return slackOk(c, { channel: formatChannel(ch, authUserId, authSlackUser?.name) });

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

    return slackOk(c, { channel: formatChannel(updated, authUserId, authSlackUser?.name) });
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
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (isDirectConversation(ch)) return slackError(c, "method_not_supported_for_channel_type");
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

    return slackOk(c, { channel: formatChannel(updated, authUserId, authSlackUser?.name) });
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
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (isDirectConversation(ch)) return slackError(c, "method_not_supported_for_channel_type");
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

    return slackOk(c, { purpose, channel: formatChannel(updated, authUserId, authSlackUser?.name) });
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
    const scopeError = requireSlackScopes(c, store, [slackConversationHistoryScope(ch)]);
    if (scopeError) return scopeError;
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

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
      messages: page.map((message) => formatSlackMessageForAuth(message, authUser)),
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
    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationHistoryScope(ch)]);
    if (scopeError) return scopeError;
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const allMessages = ss()
      .messages.findBy("channel_id", channel)
      .filter((m) => m.ts === ts || m.thread_ts === ts)
      .sort((a, b) => (a.ts > b.ts ? 1 : -1));

    return slackOk(c, {
      messages: allMessages.map((message) => formatSlackMessageForAuth(message, authUser)),
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
    const scopeError = requireSlackScopes(c, store, [slackConversationJoinScope(ch)]);
    if (scopeError) return scopeError;
    if (ch.is_archived) return slackError(c, "is_archived");
    if (ch.is_im || ch.is_mpim) return slackError(c, "method_not_supported_for_channel_type");

    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    if (ch.is_private && !isChannelMember(ch, authSlackUser, authUserId)) {
      return slackError(c, "not_in_channel");
    }

    const memberKey = getChannelMemberKey(ch, authSlackUser, authUserId);
    if (!memberKey) {
      const updated = ss().channels.update(ch.id, {
        members: [...ch.members, authUserId],
        num_members: ch.num_members + 1,
      })!;
      await dispatchMemberJoined(updated, authUserId);
    }

    const updated = ss().channels.findOneBy("channel_id", channel)!;
    return slackOk(c, { channel: formatChannel(updated, authUserId, authSlackUser?.name) });
  });

  // conversations.leave
  app.post("/api/conversations.leave", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (ch.is_im) return slackError(c, "method_not_supported_for_channel_type");
    if (isGeneralChannel(ch)) return slackError(c, "cant_leave_general");

    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    const memberKey = getChannelMemberKey(ch, authSlackUser, authUserId);
    if (!memberKey) return c.json({ ok: false, not_in_channel: true });

    const aliases = memberAliases(authSlackUser, authUserId);
    const updatedMembers = ch.members.filter((m) => !aliases.has(m));
    if (updatedMembers.length === 0) return slackError(c, "last_member");

    const updated = ss().channels.update(ch.id, {
      members: updatedMembers,
      num_members: updatedMembers.length,
    })!;
    await dispatchMemberLeft(updated, authUserId);

    return slackOk(c, {});
  });

  // conversations.invite
  app.post("/api/conversations.invite", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const users = parseUserList(body.users);
    if (!channel) return slackError(c, "channel_not_found");
    if (users.length === 0) return slackError(c, "user_not_found");
    if (users.length > 100) return slackError(c, "too_many_users");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (ch.is_archived) return slackError(c, "is_archived");
    if (ch.is_im) return slackError(c, "method_not_supported_for_channel_type");

    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const errors: Array<{ user: string; ok: false; error: string }> = [];
    const validUsers: string[] = [];
    for (const userId of users) {
      const user = ss().users.findOneBy("user_id", userId);
      if (!user || user.deleted) {
        errors.push({ user: userId, ok: false, error: "user_not_found" });
      } else if (userId === authUserId) {
        errors.push({ user: userId, ok: false, error: "cant_invite_self" });
      } else if (isChannelMember(ch, user, userId)) {
        errors.push({ user: userId, ok: false, error: "already_in_channel" });
      } else {
        validUsers.push(userId);
      }
    }

    if (errors.length > 0) {
      return c.json({ ok: false, error: errors[0].error, errors });
    }

    const updatedMembers = [...ch.members, ...validUsers];
    const updated = ss().channels.update(ch.id, {
      members: updatedMembers,
      num_members: updatedMembers.length,
    })!;

    for (const user of validUsers) {
      await dispatchMemberJoined(updated, user, authUserId);
    }

    return slackOk(c, { channel: formatChannel(updated, authUserId, authSlackUser?.name) });
  });

  // conversations.kick
  app.post("/api/conversations.kick", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const user = typeof body.user === "string" ? body.user : "";
    if (!channel) return slackError(c, "channel_not_found");
    if (!user) return slackError(c, "user_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    if (ch.is_archived) return slackError(c, "is_archived");
    if (isGeneralChannel(ch)) return slackError(c, "cant_kick_from_general");
    if (ch.is_im) return slackError(c, "method_not_supported_for_channel_type");

    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");
    if (user === authUserId) return slackError(c, "cant_kick_self");
    const targetUser = ss().users.findOneBy("user_id", user);
    if (!targetUser) return slackError(c, "user_not_found");
    const targetMemberKey = getChannelMemberKey(ch, targetUser, user);
    if (!targetMemberKey) return slackError(c, "user_not_in_channel");

    const targetAliases = memberAliases(targetUser, user);
    const updatedMembers = ch.members.filter((member) => !targetAliases.has(member));
    const updated = ss().channels.update(ch.id, {
      members: updatedMembers,
      num_members: updatedMembers.length,
    })!;
    await dispatchMemberLeft(updated, user);

    return slackOk(c, { errors: {} });
  });

  // conversations.open
  app.post("/api/conversations.open", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const users = parseUserList(body.users);
    const returnIm = isTruthySlackBoolean(body.return_im);
    const preventCreation = isTruthySlackBoolean(body.prevent_creation);
    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);

    if (channel) {
      const existing = ss().channels.findOneBy("channel_id", channel);
      if (!existing || (!existing.is_im && !existing.is_mpim)) return slackError(c, "channel_not_found");
      const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(existing)]);
      if (scopeError) return scopeError;
      if (!isChannelMember(existing, authSlackUser, authUserId)) return slackError(c, "not_in_channel");
      const alreadyOpen = getSlackConversationOpenState(existing, authUserId);
      const updated = alreadyOpen
        ? existing
        : ss().channels.update(existing.id, setSlackConversationOpenState(existing, authUserId, true))!;
      if (!alreadyOpen) await dispatchConversationEvent(openEventType(updated), { channel: updated.channel_id });
      return slackOk(c, {
        ...(alreadyOpen ? { no_op: true, already_open: true } : {}),
        channel: returnIm ? formatChannel(updated, authUserId, authSlackUser?.name) : { id: updated.channel_id },
      });
    }

    if (users.length === 0) return slackError(c, "users_list_not_supplied");
    if (users.length > 8) return slackError(c, "too_many_users");

    const targetUsers: SlackUser[] = [];
    for (const userId of users) {
      if (userId === authUserId) continue;
      const user = ss().users.findOneBy("user_id", userId);
      if (!user || user.deleted) return slackError(c, "user_not_found");
      targetUsers.push(user);
    }
    if (targetUsers.length === 0) return slackError(c, "users_list_not_supplied");

    const memberIds = [...new Set([authUserId, ...targetUsers.map((user) => user.user_id)])];
    const isMpim = memberIds.length > 2;
    const scopeError = requireSlackScopes(c, store, [isMpim ? "mpim:write" : "im:write"]);
    if (scopeError) return scopeError;
    const existing = findConversationByMembers(ss().channels.all(), memberIds, isMpim);
    if (existing) {
      const alreadyOpen = getSlackConversationOpenState(existing, authUserId);
      const updated = alreadyOpen
        ? existing
        : ss().channels.update(existing.id, setSlackConversationOpenState(existing, authUserId, true))!;
      if (!alreadyOpen) await dispatchConversationEvent(openEventType(updated), { channel: updated.channel_id });
      return slackOk(c, {
        ...(alreadyOpen ? { no_op: true, already_open: true } : {}),
        channel: returnIm ? formatChannel(updated, authUserId, authSlackUser?.name) : { id: updated.channel_id },
      });
    }
    if (preventCreation) return slackError(c, "channel_not_found");

    const team = ss().teams.all()[0];
    const now = Math.floor(Date.now() / 1000);
    const created = ss().channels.insert({
      channel_id: generateSlackId(isMpim ? "G" : "D"),
      team_id: team?.team_id ?? "T000000001",
      name: isMpim
        ? `mpdm-${targetUsers.map((user) => user.name).join("-")}`
        : (targetUsers[0]?.name ?? "direct-message"),
      is_channel: false,
      is_private: true,
      is_im: !isMpim,
      is_mpim: isMpim,
      is_open_by_user: { [authUserId]: true },
      user: isMpim ? undefined : targetUsers[0]?.user_id,
      is_archived: false,
      topic: { value: "", creator: authUserId, last_set: now },
      purpose: { value: "", creator: authUserId, last_set: now },
      members: memberIds,
      creator: authUserId,
      num_members: memberIds.length,
      last_read: {},
    });

    await dispatchConversationEvent(created.is_im ? "im_created" : "group_joined", {
      channel: formatChannel(created, authUserId, authSlackUser?.name),
    });
    await dispatchConversationEvent(openEventType(created), { channel: created.channel_id });

    return slackOk(c, {
      channel: returnIm ? formatChannel(created, authUserId, authSlackUser?.name) : { id: created.channel_id },
    });
  });

  // conversations.close
  app.post("/api/conversations.close", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    if (!channel) return slackError(c, "channel_not_found");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch || (!ch.is_im && !ch.is_mpim)) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;
    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");
    if (!getSlackConversationOpenState(ch, authUserId)) {
      return slackOk(c, { no_op: true, already_closed: true });
    }

    const updated = ss().channels.update(ch.id, setSlackConversationOpenState(ch, authUserId, false))!;
    await dispatchConversationEvent(closeEventType(updated), { channel: updated.channel_id });
    return slackOk(c, {});
  });

  // conversations.mark
  app.post("/api/conversations.mark", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const ts = typeof body.ts === "string" ? body.ts : "";
    if (!channel) return slackError(c, "channel_not_found");
    if (!ts) return slackError(c, "invalid_ts");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (!ch) return slackError(c, "channel_not_found");
    const scopeError = requireSlackScopes(c, store, [slackConversationWriteScope(ch)]);
    if (scopeError) return scopeError;

    const authUserId = getAuthUserId(authUser);
    const authSlackUser = getAuthSlackUser(authUser);
    if (!isChannelMember(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    ss().channels.update(ch.id, {
      last_read: { ...(ch.last_read ?? {}), [authUserId]: ts },
    });
    await dispatchConversationEvent(markEventType(ch), { channel: ch.channel_id, ts });

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
    const scopeError = requireSlackScopes(c, store, [slackConversationReadScope(ch)]);
    if (scopeError) return scopeError;
    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(ch, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    return slackOk(c, {
      members: ch.members,
      response_metadata: { next_cursor: "" },
    });
  });
}

function formatChannel(ch: SlackChannel, viewer?: string, viewerName?: string) {
  const imUser = ch.is_im && viewer ? ch.members.find((member) => member !== viewer) : ch.user;
  const isMember = viewer
    ? ch.members.includes(viewer) || (viewerName !== undefined && ch.members.includes(viewerName))
    : undefined;
  return {
    id: ch.channel_id,
    name: ch.name,
    name_normalized: ch.name,
    is_channel: ch.is_channel,
    is_group: ch.is_private && !ch.is_im && !ch.is_mpim,
    is_im: ch.is_im ?? false,
    is_mpim: ch.is_mpim ?? false,
    is_private: ch.is_private,
    is_archived: ch.is_archived,
    is_open: getSlackConversationOpenState(ch, viewer),
    ...(imUser ? { user: imUser } : {}),
    is_member: viewer ? isMember : undefined,
    last_read: viewer ? (ch.last_read?.[viewer] ?? "0000000000.000000") : undefined,
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

function isDirectConversation(ch: SlackChannel): boolean {
  return Boolean(ch.is_im || ch.is_mpim);
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

function parseConversationTypes(value: unknown): Set<string> {
  const raw = typeof value === "string" && value.length > 0 ? value : "public_channel";
  return new Set(
    raw
      .split(",")
      .map((type) => type.trim())
      .filter(Boolean),
  );
}

function readScopesForConversationTypes(types: Set<string>): string[] {
  const scopes: string[] = [];
  if (types.has("public_channel")) scopes.push("channels:read");
  if (types.has("private_channel")) scopes.push("groups:read");
  if (types.has("im")) scopes.push("im:read");
  if (types.has("mpim")) scopes.push("mpim:read");
  return scopes.length > 0 ? scopes : ["channels:read"];
}

function matchesConversationTypes(ch: SlackChannel, types: Set<string>): boolean {
  if (types.has("public_channel") && !ch.is_private && !ch.is_im && !ch.is_mpim) return true;
  if (types.has("private_channel") && ch.is_private && !ch.is_im && !ch.is_mpim) return true;
  if (types.has("im") && ch.is_im) return true;
  if (types.has("mpim") && ch.is_mpim) return true;
  return false;
}

function parseUserList(value: unknown): string[] {
  const users = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(users.map((user) => String(user).trim()).filter(Boolean))];
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftKey = [...left].sort().join(",");
  const rightKey = [...right].sort().join(",");
  return leftKey === rightKey;
}

function findConversationByMembers(
  channels: SlackChannel[],
  members: string[],
  isMpim: boolean,
): SlackChannel | undefined {
  return channels.find(
    (ch) => Boolean(ch.is_mpim) === isMpim && Boolean(ch.is_im) === !isMpim && sameMembers(ch.members, members),
  );
}

function findNamedChannel(channels: SlackChannel[], name: string): SlackChannel | undefined {
  return channels.find((ch) => !ch.is_im && !ch.is_mpim && ch.name === name);
}

function fileChannels(file: SlackFile): string[] {
  return [...file.channels, ...file.groups, ...file.ims];
}

function filterVisibleShares(shares: Record<string, SlackFileShare[]> | undefined, visibleIds: Set<string>) {
  const entries = Object.entries(shares ?? {}).filter(([channelId]) => visibleIds.has(channelId));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function channelTypeLetter(ch: SlackChannel): "C" | "D" | "G" {
  if (ch.is_im) return "D";
  if (ch.is_private || ch.is_mpim) return "G";
  return "C";
}

function openEventType(ch: SlackChannel): "group_open" | "im_open" {
  return ch.is_im ? "im_open" : "group_open";
}

function closeEventType(ch: SlackChannel): "group_close" | "im_close" {
  return ch.is_im ? "im_close" : "group_close";
}

function markEventType(ch: SlackChannel): "channel_marked" | "group_marked" | "im_marked" {
  if (ch.is_im) return "im_marked";
  if (ch.is_private || ch.is_mpim) return "group_marked";
  return "channel_marked";
}
