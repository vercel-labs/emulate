import { createHmac, randomUUID } from "node:crypto";
import type { JiraChangelog, JiraComment, JiraIssue, JiraWebhook } from "./entities.js";
import type { Actor, EditIssueResult } from "./issue-service.js";
import { formatUser, type Fmt } from "./formatters.js";
import { formatComment, formatIssue, formatIssueRef } from "./issue-format.js";
import { compileJql, JqlError } from "./jql.js";
import { insertFrom } from "./store.js";

export type JiraIssueEvent = "jira:issue_created" | "jira:issue_updated" | "jira:issue_deleted";
export type JiraCommentEvent = "comment_created" | "comment_updated" | "comment_deleted";

export const WEBHOOK_EVENTS: readonly string[] = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
];

export interface IssueEventOptions {
  changelog?: JiraChangelog | null;
  comments?: JiraComment[];
}

/** Webhook payloads use the REST API v2 representation at the site URL. */
function payloadFmt(actor: Actor): Fmt {
  return { js: actor.js, baseUrl: actor.baseUrl, siteUrl: actor.baseUrl, version: "2", user: actor.user };
}

function issueEventType(event: JiraIssueEvent, opts: IssueEventOptions): string {
  if (event === "jira:issue_created") return "issue_created";
  if (event === "jira:issue_deleted") return "issue_deleted";
  const items = opts.changelog?.items ?? [];
  if (items.length === 0 && opts.comments?.length) return "issue_commented";
  if (items.some((item) => item.field === "status")) return "issue_generic";
  if (items.length > 0 && items.every((item) => item.field === "assignee")) return "issue_assigned";
  return "issue_updated";
}

function matchesFilter(actor: Actor, webhook: JiraWebhook, issue: JiraIssue): boolean {
  if (!webhook.jql_filter?.trim()) return true;
  try {
    return compileJql(actor.js, webhook.jql_filter, actor.user)(issue);
  } catch (err) {
    if (err instanceof JqlError) return false;
    throw err;
  }
}

function matchingWebhooks(actor: Actor, event: string, issue: JiraIssue): JiraWebhook[] {
  const now = Date.now();
  return actor.js.webhooks.all().filter((webhook) => {
    if (!webhook.enabled || !webhook.events.includes(event)) return false;
    if (webhook.expiration_date && new Date(webhook.expiration_date).getTime() <= now) return false;
    return matchesFilter(actor, webhook, issue);
  });
}

export async function emitIssueEvent(
  actor: Actor,
  event: JiraIssueEvent,
  issue: JiraIssue,
  opts: IssueEventOptions = {},
): Promise<void> {
  const webhooks = matchingWebhooks(actor, event, issue);
  if (webhooks.length === 0) return;
  const fmt = payloadFmt(actor);
  const payload: Record<string, unknown> = {
    timestamp: Date.now(),
    webhookEvent: event,
    issue_event_type_name: issueEventType(event, opts),
    user: formatUser(fmt, actor.user),
    issue: formatIssue(fmt, issue),
  };
  if (opts.changelog) payload.changelog = { id: String(opts.changelog.id), items: opts.changelog.items };
  if (opts.comments?.length) payload.comment = formatComment(fmt, opts.comments[opts.comments.length - 1]);
  await deliverAll(actor, webhooks, event, payload);
}

export async function emitCommentEvent(
  actor: Actor,
  event: JiraCommentEvent,
  issue: JiraIssue,
  comment: JiraComment,
): Promise<void> {
  const webhooks = matchingWebhooks(actor, event, issue);
  if (webhooks.length === 0) return;
  const fmt = payloadFmt(actor);
  const ref = formatIssueRef(fmt, issue);
  const project = actor.js.projects.get(issue.project_id);
  await deliverAll(actor, webhooks, event, {
    timestamp: Date.now(),
    webhookEvent: event,
    comment: formatComment(fmt, comment),
    issue: {
      ...ref,
      fields: {
        ...ref.fields,
        project: project ? { id: String(project.id), key: project.key, name: project.name } : null,
      },
    },
  });
}

/** Sends the issue and comment events for the result of an edit or transition. */
export async function emitEditEvents(actor: Actor, result: EditIssueResult): Promise<void> {
  for (const comment of result.comments) {
    await emitCommentEvent(actor, "comment_created", result.issue, comment);
  }
  // Like Jira, one edit sends one jira:issue_updated, carrying both the changelog and the new comment.
  if (result.changelog || result.comments.length > 0) {
    await emitIssueEvent(actor, "jira:issue_updated", result.issue, {
      changelog: result.changelog,
      comments: result.comments,
    });
  }
}

/** Admin webhooks each get their own request. Dynamic webhooks are grouped per app URL with matchedWebhookIds. */
async function deliverAll(actor: Actor, webhooks: JiraWebhook[], event: string, payload: Record<string, unknown>) {
  const admin = webhooks.filter((webhook) => webhook.kind === "admin");
  for (const webhook of admin) await deliver(actor, [webhook], event, payload);

  const groups = new Map<string, JiraWebhook[]>();
  for (const webhook of webhooks.filter((w) => w.kind === "dynamic")) {
    const key = `${webhook.client_id}\n${webhook.url}`;
    groups.set(key, [...(groups.get(key) ?? []), webhook]);
  }
  for (const group of groups.values()) {
    await deliver(actor, group, event, { ...payload, matchedWebhookIds: group.map((webhook) => webhook.id) });
  }
}

async function deliver(actor: Actor, webhooks: JiraWebhook[], event: string, payload: Record<string, unknown>) {
  const [webhook] = webhooks;
  const body = webhook.exclude_body ? "" : JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "Atlassian Webhook HTTP Client",
    "X-Atlassian-Webhook-Identifier": randomUUID(),
  };
  if (webhook.secret) {
    headers["X-Hub-Signature"] = `sha256=${createHmac("sha256", webhook.secret).update(body).digest("hex")}`;
  }

  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(webhook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    status = res.status;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  insertFrom(actor.js.webhookDeliveries, 1, {
    webhook_id: webhook.id,
    event,
    url: webhook.url,
    status,
    error,
    payload: webhook.exclude_body ? null : payload,
    headers,
  });
}
