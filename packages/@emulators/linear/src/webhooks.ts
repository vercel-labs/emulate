import { createHmac } from "node:crypto";
import type { Store } from "@emulators/core";
import { getLinearStore } from "./store.js";
import { linearId } from "./ids.js";
import type { LinearUser } from "./entities.js";

export interface LinearAgentSessionWebhookPayload {
  id: string;
  appUserId: string;
  organizationId: string;
  issueId: string | null;
  commentId: string | null;
  creatorId: string | null;
  creator: LinearUserWebhookPayload | null;
  status: string;
  archivedAt: string | null;
  sourceCommentId: string | null;
  sourceMetadata: Record<string, unknown> | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
  url: string | null;
  issue: LinearIssueWebhookPayload | null;
  comment: LinearCommentWebhookPayload | null;
}

export interface LinearAgentActivityWebhookPayload {
  id: string;
  agentSessionId: string;
  content: Record<string, unknown>;
  signal: string | null;
  signalMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  sourceCommentId: string | null;
  userId: string;
  user: LinearUserWebhookPayload;
}

export interface LinearUserWebhookPayload {
  id: string;
  url: string;
  avatarUrl: string | null;
  email: string;
  name: string;
}

export interface LinearCommentWebhookPayload {
  id: string;
  body: string;
  documentContentId: string | null;
  initiativeId: string | null;
  initiativeUpdateId: string | null;
  issueId: string | null;
  projectId: string | null;
  projectUpdateId: string | null;
  userId: string | null;
}

export interface LinearIssueWebhookPayload {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  teamId: string;
  team: { id: string; key: string; name: string };
}

export interface LinearWebhookEvent {
  type: string;
  action: string;
  data?: unknown;
  actor?: LinearUser | null;
  teamId?: string | null;
  url?: string | null;
  updatedFrom?: Record<string, unknown>;
  /** AgentSessionEvent fields (production Linear shape). */
  agentSession?: LinearAgentSessionWebhookPayload;
  agentActivity?: LinearAgentActivityWebhookPayload;
  appUserId?: string | null;
  oauthClientId?: string | null;
  promptContext?: string | null;
  guidance?: unknown[] | null;
  previousComments?: LinearCommentWebhookPayload[] | null;
}

export async function dispatchLinearWebhook(store: Store, event: LinearWebhookEvent): Promise<void> {
  const ls = getLinearStore(store);
  const organization = ls.organizations.all()[0];
  const webhooks = ls.webhooks.all().filter((webhook) => {
    if (!webhook.enabled) return false;
    if (!webhook.resource_types.includes(event.type) && !webhook.resource_types.includes("*")) return false;
    if (webhook.all_public_teams) {
      const team = event.teamId ? ls.teams.findOneBy("linear_id", event.teamId) : undefined;
      return !team?.private;
    }
    return webhook.team_id === event.teamId;
  });

  for (const webhook of webhooks) {
    const isAgentSessionEvent = event.type === "AgentSessionEvent";
    const payload = isAgentSessionEvent
      ? {
          action: event.action,
          type: event.type,
          agentSession: event.agentSession ?? null,
          ...(event.agentActivity !== undefined ? { agentActivity: event.agentActivity } : {}),
          appUserId: event.appUserId ?? null,
          oauthClientId: event.oauthClientId ?? null,
          organizationId: organization?.linear_id ?? null,
          ...(event.promptContext != null ? { promptContext: event.promptContext } : {}),
          guidance: event.guidance ?? [],
          ...(event.previousComments != null ? { previousComments: event.previousComments } : {}),
          createdAt: new Date().toISOString(),
          webhookTimestamp: Date.now(),
          webhookId: webhook.linear_id,
        }
      : {
          action: event.action,
          type: event.type,
          actor: event.actor
            ? {
                id: event.actor.linear_id,
                name: event.actor.name,
                displayName: event.actor.display_name,
                email: event.actor.email,
              }
            : null,
          data: event.data,
          url: event.url ?? null,
          createdAt: new Date().toISOString(),
          organizationId: organization?.linear_id ?? null,
          webhookTimestamp: Date.now(),
          webhookId: webhook.linear_id,
          ...(event.updatedFrom ? { updatedFrom: event.updatedFrom } : {}),
        };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": linearId(),
      "Linear-Event": event.type,
      "Linear-Timestamp": String(payload.webhookTimestamp),
      "User-Agent": "Linear-Webhook",
    };
    if (webhook.secret) {
      headers["Linear-Signature"] = createHmac("sha256", webhook.secret).update(body).digest("hex");
    }

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      status = res.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    ls.webhookDeliveries.insert({
      linear_id: linearId(),
      webhook_id: webhook.linear_id,
      event: event.type,
      action: event.action,
      url: webhook.url,
      status,
      error,
      payload,
      headers,
    });
  }
}
