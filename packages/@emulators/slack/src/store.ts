import { Store, type Collection } from "@emulators/core";
import type { SlackTeam, SlackUser, SlackChannel, SlackMessage, SlackBot, SlackOAuthApp, SlackIncomingWebhook } from "./entities.js";

export interface SlackStore {
  teams: Collection<SlackTeam>;
  users: Collection<SlackUser>;
  channels: Collection<SlackChannel>;
  messages: Collection<SlackMessage>;
  bots: Collection<SlackBot>;
  oauthApps: Collection<SlackOAuthApp>;
  incomingWebhooks: Collection<SlackIncomingWebhook>;
}

export function getSlackStore(store: Store): SlackStore {
  return {
    teams: store.collection<SlackTeam>("slack.teams", ["team_id"]),
    users: store.collection<SlackUser>("slack.users", ["user_id", "email"]),
    channels: store.collection<SlackChannel>("slack.channels", ["channel_id", "name"]),
    messages: store.collection<SlackMessage>("slack.messages", ["ts", "channel_id"]),
    bots: store.collection<SlackBot>("slack.bots", ["bot_id"]),
    oauthApps: store.collection<SlackOAuthApp>("slack.oauth_apps", ["client_id"]),
    incomingWebhooks: store.collection<SlackIncomingWebhook>("slack.incoming_webhooks", ["token"]),
  };
}
