import type { RouteContext } from "@emulators/core";
import type { SlackBookmark, SlackChannel, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import { generateSlackId, parseSlackBody, requireSlackScopes, slackError, slackOk, onGetOrPost } from "../helpers.js";

export function bookmarksRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const isChannelMember = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  const canReadConversation = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    !channel.is_private || isChannelMember(channel, user, userId);

  app.post("/api/bookmarks.add", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["bookmarks:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = stringField(body.channel_id) || stringField(body.channel);
    const channel = findBookmarkChannel(channelId);
    if (!channel) return slackError(c, "channel_not_found");
    if (channel.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const title = stringField(body.title).trim();
    const type = stringField(body.type);
    const link = stringField(body.link) || stringField(body.url);
    if (type !== "link") return slackError(c, "invalid_bookmark_type");
    if (!title || !link) return slackError(c, "invalid_arguments");
    if (!isValidBookmarkLink(link)) return slackError(c, "invalid_link");
    if (ss().bookmarks.findBy("channel_id", channel.channel_id).length >= 100) {
      return slackError(c, "too_many_bookmarks");
    }

    const now = Math.floor(Date.now() / 1000);
    const team = ss().teams.all()[0];
    const bookmark = ss().bookmarks.insert({
      bookmark_id: generateSlackId("Bk"),
      team_id: team?.team_id ?? channel.team_id,
      channel_id: channel.channel_id,
      title,
      type: "link",
      link,
      emoji: stringField(body.emoji),
      icon_url: bookmarkIconUrl(link),
      entity_id: null,
      date_created: now,
      date_updated: 0,
      rank: bookmarkRank(channel.channel_id),
      last_updated_by_user_id: authUserId,
      last_updated_by_team_id: team?.team_id ?? channel.team_id,
      shortcut_id: null,
      app_id: null,
      ...(accessLevel(body.access_level) ? { access_level: accessLevel(body.access_level) } : {}),
      ...(stringField(body.parent_id) ? { parent_id: stringField(body.parent_id) } : {}),
    });

    return slackOk(c, { bookmark: formatBookmark(bookmark) });
  });

  app.post("/api/bookmarks.edit", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["bookmarks:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = stringField(body.channel_id) || stringField(body.channel);
    const bookmarkId = stringField(body.bookmark_id);
    const channel = findBookmarkChannel(channelId);
    if (!channel) return slackError(c, "channel_not_found");
    if (channel.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const bookmark = findBookmark(channel.channel_id, bookmarkId);
    if (!bookmark) return slackError(c, "not_found");

    const updates: Partial<SlackBookmark> = {
      date_updated: Math.floor(Date.now() / 1000),
      last_updated_by_user_id: authUserId,
    };
    const title = stringField(body.title).trim();
    const link = stringField(body.link) || stringField(body.url);
    const emoji = stringField(body.emoji);
    if (title) updates.title = title;
    if (link) {
      if (!isValidBookmarkLink(link)) return slackError(c, "invalid_link");
      updates.link = link;
      updates.icon_url = bookmarkIconUrl(link);
    }
    if (Object.prototype.hasOwnProperty.call(body, "emoji")) updates.emoji = emoji;

    const updated = ss().bookmarks.update(bookmark.id, updates)!;
    return slackOk(c, { bookmark: formatBookmark(updated) });
  });

  onGetOrPost(app, "/api/bookmarks.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["bookmarks:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = stringField(body.channel_id) || stringField(body.channel);
    const channel = findBookmarkChannel(channelId);
    if (!channel) return slackError(c, "channel_not_found");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const bookmarks = ss()
      .bookmarks.findBy("channel_id", channel.channel_id)
      .sort(compareSlackBookmarks)
      .map(formatBookmark);

    return slackOk(c, { bookmarks });
  });

  app.post("/api/bookmarks.remove", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["bookmarks:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = stringField(body.channel_id) || stringField(body.channel);
    const bookmarkId = stringField(body.bookmark_id);
    const channel = findBookmarkChannel(channelId);
    if (!channel) return slackError(c, "channel_not_found");
    if (channel.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const bookmark = findBookmark(channel.channel_id, bookmarkId);
    if (!bookmark) return slackError(c, "not_found");

    ss().bookmarks.delete(bookmark.id);
    return slackOk(c, {});
  });

  function findBookmarkChannel(channelId: string): SlackChannel | undefined {
    if (!channelId) return undefined;
    return ss().channels.findOneBy("channel_id", channelId);
  }

  function findBookmark(channelId: string, bookmarkId: string): SlackBookmark | undefined {
    if (!bookmarkId) return undefined;
    return ss()
      .bookmarks.all()
      .find((bookmark) => bookmark.channel_id === channelId && bookmark.bookmark_id === bookmarkId);
  }

  function bookmarkRank(channelId: string): string {
    const maxRank = ss()
      .bookmarks.findBy("channel_id", channelId)
      .reduce((max, bookmark) => Math.max(max, validBookmarkRankNumber(bookmark) ?? 0), 0);
    return (maxRank + 1).toString(36);
  }
}

export function compareSlackBookmarks(a: SlackBookmark, b: SlackBookmark): number {
  return (
    bookmarkRankNumber(a) - bookmarkRankNumber(b) ||
    a.date_created - b.date_created ||
    a.id - b.id ||
    a.bookmark_id.localeCompare(b.bookmark_id)
  );
}

function formatBookmark(bookmark: SlackBookmark) {
  return {
    id: bookmark.bookmark_id,
    channel_id: bookmark.channel_id,
    title: bookmark.title,
    link: bookmark.link,
    emoji: bookmark.emoji,
    icon_url: bookmark.icon_url,
    type: bookmark.type,
    entity_id: bookmark.entity_id,
    date_created: bookmark.date_created,
    date_updated: bookmark.date_updated,
    rank: bookmark.rank,
    last_updated_by_user_id: bookmark.last_updated_by_user_id,
    last_updated_by_team_id: bookmark.last_updated_by_team_id,
    shortcut_id: bookmark.shortcut_id,
    app_id: bookmark.app_id,
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function accessLevel(value: unknown): "read" | "write" | undefined {
  if (value === "read" || value === "write") return value;
  return undefined;
}

function bookmarkRankNumber(bookmark: SlackBookmark): number {
  return validBookmarkRankNumber(bookmark) ?? Number.MAX_SAFE_INTEGER;
}

function validBookmarkRankNumber(bookmark: SlackBookmark): number | undefined {
  if (!/^[0-9a-z]+$/i.test(bookmark.rank)) return undefined;
  const rank = parseInt(bookmark.rank, 36);
  return Number.isSafeInteger(rank) ? rank : undefined;
}

function bookmarkIconUrl(link: string): string {
  try {
    const url = new URL(link);
    return `${url.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function isValidBookmarkLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
