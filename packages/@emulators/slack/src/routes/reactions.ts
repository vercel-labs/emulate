import type { RouteContext } from "@emulators/core";
import type { SlackChannel } from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackMessage,
  slackOk,
  slackError,
  parseSlackBody,
  requireSlackScopes,
  onGetOrPost,
} from "../helpers.js";

export function reactionsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const getAuthUserAliases = (authUser: { login: string }) => {
    const user = getAuthSlackUser(authUser);
    return new Set([authUser.login, user?.user_id, user?.name].filter((value): value is string => Boolean(value)));
  };
  const isAuthChannelMember = (channel: SlackChannel, authUser: { login: string }) => {
    const user = getAuthSlackUser(authUser);
    const userId = user?.user_id ?? authUser.login;
    return channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  };
  const canAccessConversation = (channel: SlackChannel, authUser: { login: string }) =>
    !channel.is_private || isAuthChannelMember(channel, authUser);

  // reactions.add
  onGetOrPost(app, "/api/reactions.add", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!name) return slackError(c, "invalid_name");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const reactions = [...msg.reactions];
    const existing = reactions.find((r) => r.name === name);
    const authUserId = getAuthUserId(authUser);
    const aliases = getAuthUserAliases(authUser);
    if (existing) {
      if (existing.users.some((user) => aliases.has(user))) {
        return slackError(c, "already_reacted");
      }
      existing.users.push(authUserId);
      existing.count++;
    } else {
      reactions.push({ name, users: [authUserId], count: 1 });
    }

    ss().messages.update(msg.id, { reactions });

    await webhooks.dispatch(
      "reaction_added",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "reaction_added",
          user: authUserId,
          reaction: name,
          item: { type: "message", channel, ts: timestamp },
        },
      },
      "slack",
    );

    return slackOk(c, {});
  });

  // reactions.remove
  onGetOrPost(app, "/api/reactions.remove", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    const name = typeof body.name === "string" ? body.name : "";

    if (!name) return slackError(c, "invalid_name");

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    const reactions = [...msg.reactions];
    const existing = reactions.find((r) => r.name === name);
    const authUserId = getAuthUserId(authUser);
    const aliases = getAuthUserAliases(authUser);
    if (!existing || !existing.users.some((user) => aliases.has(user))) {
      return slackError(c, "no_reaction");
    }

    existing.users = existing.users.filter((u) => !aliases.has(u));
    existing.count = existing.users.length;

    const filtered = reactions.filter((r) => r.count > 0);
    ss().messages.update(msg.id, { reactions: filtered });

    await webhooks.dispatch(
      "reaction_removed",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "reaction_removed",
          user: authUserId,
          reaction: name,
          item: { type: "message", channel, ts: timestamp },
        },
      },
      "slack",
    );

    return slackOk(c, {});
  });

  // reactions.get
  onGetOrPost(app, "/api/reactions.get", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["reactions:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channel = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";

    const ch = ss().channels.findOneBy("channel_id", channel);
    if (ch && !canAccessConversation(ch, authUser)) return slackError(c, "not_in_channel");

    const msg = ss()
      .messages.all()
      .find((m) => m.ts === timestamp && m.channel_id === channel);
    if (!msg) return slackError(c, "message_not_found");

    return slackOk(c, {
      type: "message",
      message: { ...formatSlackMessage(msg), reactions: msg.reactions },
    });
  });
}
