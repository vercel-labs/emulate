import type { Context, RouteContext } from "@emulators/core";
import type { SlackChannel, SlackMessage, SlackPin, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import {
  formatSlackMessage,
  formatSlackPermalink,
  generateSlackId,
  generateTs,
  parseSlackBody,
  requireSlackScopes,
  slackError,
  slackOk,
} from "../helpers.js";

export function pinsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, baseUrl } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;
  const isChannelMember = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    channel.members.includes(userId) || (user ? channel.members.includes(user.name) : false);
  const canReadConversation = (channel: SlackChannel, user: SlackUser | undefined, userId: string) =>
    !channel.is_private || isChannelMember(channel, user, userId);
  const findPinnedMessage = (channelId: string, timestamp: string) =>
    ss()
      .messages.all()
      .find((message) => message.channel_id === channelId && message.ts === timestamp);
  const findPin = (channelId: string, timestamp: string) =>
    ss()
      .pins.all()
      .find((pin) => pin.channel_id === channelId && pin.message_ts === timestamp);

  app.post("/api/pins.add", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["pins:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    if (!channelId) return slackError(c, "channel_not_found");
    if (!timestamp) return slackError(c, "no_item_specified");
    if (!isSlackTimestamp(timestamp)) return slackError(c, "bad_timestamp");

    const channel = ss().channels.findOneBy("channel_id", channelId);
    if (!channel) return slackError(c, "channel_not_found");
    if (channel.is_archived) return slackError(c, "is_archived");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const message = findPinnedMessage(channel.channel_id, timestamp);
    if (!message) return slackError(c, "message_not_found");
    if (findPin(channel.channel_id, timestamp)) return slackError(c, "already_pinned");

    const pin = ss().pins.insert({
      pin_id: generateSlackId("P"),
      team_id: channel.team_id,
      channel_id: channel.channel_id,
      message_ts: timestamp,
      created: Math.floor(Date.now() / 1000),
      created_by: authUserId,
    });

    await dispatchPinEvent("pin_added", {
      user: authUserId,
      channel_id: channel.channel_id,
      item: formatPinItem(pin, message),
      event_ts: generateTs(),
    });

    return slackOk(c, {});
  });

  async function pinList(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["pins:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackRequest(c);
    const channelId = typeof body.channel === "string" ? body.channel : "";
    if (!channelId) return slackError(c, "channel_not_found");

    const channel = ss().channels.findOneBy("channel_id", channelId);
    if (!channel) return slackError(c, "channel_not_found");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!canReadConversation(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const items = ss()
      .pins.findBy("channel_id", channel.channel_id)
      .sort((a, b) => b.created - a.created)
      .flatMap((pin) => {
        const message = findPinnedMessage(pin.channel_id, pin.message_ts);
        return message ? [formatPinItem(pin, message)] : [];
      });

    return slackOk(c, { items });
  }

  app.get("/api/pins.list", pinList);
  app.post("/api/pins.list", pinList);

  app.post("/api/pins.remove", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["pins:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const channelId = typeof body.channel === "string" ? body.channel : "";
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    if (!channelId) return slackError(c, "channel_not_found");
    if (!timestamp) return slackError(c, "no_item_specified");
    if (!isSlackTimestamp(timestamp)) return slackError(c, "bad_timestamp");

    const channel = ss().channels.findOneBy("channel_id", channelId);
    if (!channel) return slackError(c, "channel_not_found");

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = getAuthUserId(authUser);
    if (!isChannelMember(channel, authSlackUser, authUserId)) return slackError(c, "not_in_channel");

    const pin = findPin(channel.channel_id, timestamp);
    const message = findPinnedMessage(channel.channel_id, timestamp);
    if (!pin) return slackError(c, "no_pin");

    ss().pins.delete(pin.id);
    if (!message) return slackOk(c, {});

    const hasPins = ss().pins.findBy("channel_id", channel.channel_id).length > 0;
    await dispatchPinEvent("pin_removed", {
      user: authUserId,
      channel_id: channel.channel_id,
      item: formatPinItem(pin, message),
      has_pins: hasPins,
      event_ts: generateTs(),
    });

    return slackOk(c, {});
  });

  function formatPinItem(pin: SlackPin, message: SlackMessage) {
    return {
      type: "message",
      channel: pin.channel_id,
      created: pin.created,
      created_by: pin.created_by,
      message: {
        ...formatSlackMessage(message),
        pinned_to: [pin.channel_id],
        permalink: formatSlackPermalink(baseUrl, pin.channel_id, message),
      },
    };
  }

  async function dispatchPinEvent(type: "pin_added" | "pin_removed", event: Record<string, unknown>) {
    await webhooks.dispatch(
      type,
      undefined,
      {
        type: "event_callback",
        event: { type, ...event },
      },
      "slack",
    );
  }
}

async function parseSlackRequest(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === "GET") {
    return Object.fromEntries(new URL(c.req.url).searchParams.entries());
  }
  return parseSlackBody(c);
}

function isSlackTimestamp(value: string): boolean {
  return /^\d{1,16}\.\d{1,16}$/.test(value);
}
