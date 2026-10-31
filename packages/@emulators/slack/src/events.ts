import { randomUUID } from "node:crypto";
import type { Context, Store, WebhookDispatcher } from "@emulators/core";
import { isSlackConnectChannel } from "./connect.js";
import type { SlackInstallation } from "./entities.js";
import { generateTs } from "./helpers.js";
import { getSlackStore } from "./store.js";

export async function dispatchSlackEvent(
  store: Store,
  webhooks: WebhookDispatcher,
  teamId: string,
  event: Record<string, unknown>,
  recipient?: SlackInstallation,
) {
  const ss = getSlackStore(store);
  const installations = recipient ? [recipient] : ss.installations.findBy("team_id", teamId);
  const normalizedEvent = {
    event_ts: event.type === "message" && typeof event.ts === "string" ? event.ts : generateTs(),
    ...event,
  };
  for (const installation of installations.length > 0 ? installations : [undefined]) {
    await webhooks.dispatch(
      String(event.type),
      undefined,
      buildSlackEventEnvelope(store, teamId, normalizedEvent, installation),
      "slack",
    );
  }
}

function buildSlackEventEnvelope(
  store: Store,
  teamId: string,
  event: Record<string, unknown>,
  installation?: SlackInstallation,
) {
  const ss = getSlackStore(store);
  const user = ss.users.all().find((user) => user.team_id === teamId && !user.deleted);
  const channelId =
    typeof event.channel === "string"
      ? event.channel
      : ((event.channel as { id?: string } | undefined)?.id ??
        (event.item as { channel?: string } | undefined)?.channel ??
        (typeof event.channel_id === "string" ? event.channel_id : undefined));
  const channel = channelId ? ss.channels.findOneBy("channel_id", channelId) : undefined;
  const shared = channel ? isSlackConnectChannel(store, channel) : false;
  const author = typeof event.user === "string" ? ss.users.findOneBy("user_id", event.user) : undefined;
  return {
    type: "event_callback" as const,
    token: store.getData<string>("slack.verification_token") ?? "emulate-verification-token",
    team_id: teamId,
    api_app_id: installation?.app_id ?? "A000000001",
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: installation?.bot_user_id ?? user?.user_id ?? "U000000001",
        is_bot: installation ? true : (user?.is_bot ?? false),
        is_enterprise_install: false,
      },
    ],
    event_id: `Ev${randomUUID().replaceAll("-", "")}`,
    event_time: Math.floor(Date.now() / 1000),
    ...(channel ? { is_ext_shared_channel: shared } : {}),
    event: {
      ...(event.type === "message" && channel
        ? { channel_type: channel.is_im ? "im" : channel.is_mpim ? "mpim" : channel.is_private ? "group" : "channel" }
        : {}),
      ...event,
      ...(shared && event.type === "app_mention" && author && author.team_id !== teamId
        ? { user_team: author.team_id, source_team: author.team_id }
        : {}),
    },
  };
}

export function resolveSlackEventTeamId(c: Context, store: Store, fallbackTeamId?: string): string {
  const slackStore = getSlackStore(store);
  const token = c.get("authToken");
  const tokenTeamId = token ? slackStore.tokens.findOneBy("token", token)?.team_id : undefined;
  return tokenTeamId ?? fallbackTeamId ?? slackStore.teams.all()[0]?.team_id ?? "T000000001";
}
