import { randomUUID } from "node:crypto";
import type { Context, Store } from "@emulators/core";
import { getSlackStore } from "./store.js";

export function buildSlackEventEnvelope(teamId: string, event: Record<string, unknown>) {
  return {
    type: "event_callback" as const,
    team_id: teamId,
    event_id: `Ev${randomUUID().replaceAll("-", "")}`,
    event_time: Math.floor(Date.now() / 1000),
    event,
  };
}

export function resolveSlackEventTeamId(c: Context, store: Store, fallbackTeamId?: string): string {
  const slackStore = getSlackStore(store);
  const token = c.get("authToken");
  const tokenTeamId = token ? slackStore.tokens.findOneBy("token", token)?.team_id : undefined;
  return tokenTeamId ?? fallbackTeamId ?? slackStore.teams.all()[0]?.team_id ?? "T000000001";
}
