import type { Store } from "@emulators/core";
import { getLinearStore } from "./store.js";
import type {
  LinearAgentActivity,
  LinearAgentActivityContent,
  LinearAgentActivitySignal,
  LinearAgentActivityType,
  LinearAgentExternalLink,
  LinearAgentPlan,
  LinearAgentPlanEntryStatus,
  LinearAgentSession,
  LinearComment,
  LinearUser,
} from "./entities.js";

// Validation follows the field descriptions in Linear's GraphQL schema for AgentActivityCreateInput,
// AgentSessionUpdateInput, and AgentSessionUpdateExternalUrlInput.

const ACTIVITY_TYPES: readonly LinearAgentActivityType[] = [
  "thought",
  "elicitation",
  "action",
  "response",
  "error",
  "prompt",
];
const SIGNALS: readonly LinearAgentActivitySignal[] = ["auth", "continue", "select", "stop"];
const PLAN_STATUSES: readonly LinearAgentPlanEntryStatus[] = ["pending", "inProgress", "completed", "canceled"];
const MAX_BODY_LENGTH = 250_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONTENT_TYPENAMES: Record<LinearAgentActivityType, string> = {
  action: "AgentActivityActionContent",
  elicitation: "AgentActivityElicitationContent",
  error: "AgentActivityErrorContent",
  prompt: "AgentActivityPromptContent",
  response: "AgentActivityResponseContent",
  thought: "AgentActivityThoughtContent",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markdown(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > MAX_BODY_LENGTH) throw new Error(`${field} must be at most ${MAX_BODY_LENGTH} characters`);
  return value;
}

function activityType(value: unknown, field: string): LinearAgentActivityType {
  if (typeof value === "string" && (ACTIVITY_TYPES as readonly string[]).includes(value)) {
    return value as LinearAgentActivityType;
  }
  throw new Error(`${field} must be one of: ${ACTIVITY_TYPES.join(", ")}`);
}

/** Parses the content JSON object of AgentActivityCreateInput, keeping only the fields its type defines. */
export function parseActivityContent(value: unknown): LinearAgentActivityContent {
  if (!isRecord(value)) throw new Error("content is required");
  const type = activityType(value.type, "content.type");
  switch (type) {
    case "action": {
      if (typeof value.action !== "string" || !value.action.trim()) throw new Error("content.action is required");
      if (typeof value.parameter !== "string") throw new Error("content.parameter is required");
      const content: LinearAgentActivityContent = { type, action: value.action, parameter: value.parameter };
      if (value.result !== undefined && value.result !== null)
        content.result = markdown(value.result, "content.result");
      return content;
    }
    case "error": {
      const content: LinearAgentActivityContent = { type, body: markdown(value.body, "content.body") };
      if (typeof value.reasonCode === "string" && value.reasonCode) content.reasonCode = value.reasonCode;
      return content;
    }
    case "prompt": {
      const content: LinearAgentActivityContent = { type, body: markdown(value.body, "content.body") };
      if (typeof value.title === "string" && value.title) content.title = value.title;
      return content;
    }
    default:
      return { type, body: markdown(value.body, "content.body") };
  }
}

/** Builds content from the emulator's earlier flat `{ sessionId, type, body }` input. */
export function legacyActivityContent(typeValue: unknown, body: unknown): LinearAgentActivityContent {
  const type = activityType(typeValue, "type");
  const text = markdown(body, "body");
  if (type === "action") return { type, action: text, parameter: "" };
  return { type, body: text };
}

/** The body the earlier emulator `AgentActivity.body` field returned. */
export function activityBody(content: LinearAgentActivityContent): string {
  return content.type === "action" ? content.action : content.body;
}

export function activityContentForGraphQL(content: LinearAgentActivityContent): Record<string, unknown> {
  const fields: Record<string, unknown> = { __typename: CONTENT_TYPENAMES[content.type], ...content };
  if (content.type === "action") fields.result = content.result ?? null;
  if (content.type === "error") fields.reasonCode = content.reasonCode ?? null;
  if (content.type === "prompt") fields.title = content.title ?? null;
  return fields;
}

export interface ParsedSignal {
  signal: LinearAgentActivitySignal | null;
  signalMetadata: Record<string, unknown> | null;
}

/**
 * Checks a signal against the activity it is attached to. Agents may use continue on a response and auth or select on
 * an elicitation; stop belongs to user prompts.
 */
export function parseSignal(
  type: LinearAgentActivityType,
  signalValue: unknown,
  metadataValue: unknown,
  fromAgent: boolean,
): ParsedSignal {
  if (signalValue === undefined || signalValue === null) {
    if (metadataValue !== undefined && metadataValue !== null) throw new Error("signalMetadata requires signal");
    return { signal: null, signalMetadata: null };
  }
  if (typeof signalValue !== "string" || !(SIGNALS as readonly string[]).includes(signalValue)) {
    throw new Error(`signal must be one of: ${SIGNALS.join(", ")}`);
  }
  const signal = signalValue as LinearAgentActivitySignal;
  if (signal === "stop") {
    if (fromAgent) throw new Error("The stop signal is reserved for user prompts");
    if (type !== "prompt") throw new Error("The stop signal can only be used with a prompt");
  }
  if (signal === "continue" && type !== "response")
    throw new Error("The continue signal can only be used with a response");
  if ((signal === "auth" || signal === "select") && type !== "elicitation") {
    throw new Error(`The ${signal} signal can only be used with an elicitation`);
  }

  if (signal === "auth") {
    if (!isRecord(metadataValue) || typeof metadataValue.url !== "string" || !URL.canParse(metadataValue.url)) {
      throw new Error("The auth signal requires signalMetadata.url");
    }
    const metadata: Record<string, unknown> = { url: metadataValue.url };
    if (metadataValue.userId !== undefined) {
      if (typeof metadataValue.userId !== "string" || !UUID.test(metadataValue.userId)) {
        throw new Error("signalMetadata.userId must be a UUID");
      }
      metadata.userId = metadataValue.userId;
    }
    if (typeof metadataValue.providerName === "string") metadata.providerName = metadataValue.providerName;
    return { signal, signalMetadata: metadata };
  }
  if (signal === "select") {
    const options = isRecord(metadataValue) ? metadataValue.options : undefined;
    if (!Array.isArray(options) || options.length < 1 || options.length > 100) {
      throw new Error("The select signal requires signalMetadata.options with 1 to 100 options");
    }
    return {
      signal,
      signalMetadata: {
        options: options.map((option, index) => {
          const valid = (text: unknown) => typeof text === "string" && text.length > 0 && text.length <= 256;
          if (!isRecord(option) || !valid(option.value) || (option.label !== undefined && !valid(option.label))) {
            throw new Error(
              `signalMetadata.options[${index}] needs a value and an optional label of up to 256 characters`,
            );
          }
          return option.label === undefined ? { value: option.value } : { label: option.label, value: option.value };
        }),
      },
    };
  }
  if (metadataValue !== undefined && metadataValue !== null) {
    throw new Error(`The ${signal} signal does not take signalMetadata`);
  }
  return { signal, signalMetadata: null };
}

export function parseEphemeral(type: LinearAgentActivityType, value: unknown, fallback = false): boolean {
  const ephemeral = typeof value === "boolean" ? value : fallback;
  if (ephemeral && type !== "thought" && type !== "action") {
    throw new Error("Only thought and action activities can be ephemeral");
  }
  return ephemeral;
}

export function parseActivityId(value: unknown, store: Store): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !UUID_V4.test(value)) throw new Error("id must be a UUID v4");
  if (getLinearStore(store).agentActivities.findOneBy("linear_id", value)) {
    throw new Error(`Agent activity already exists: ${value}`);
  }
  return value;
}

/**
 * Parses an agentSessionUpdate plan: an array of 1 to 100 `{ content, status }` entries, stored with the time it was
 * accepted. Null clears the plan. A string is kept as is for the emulator's earlier free-form plan input.
 */
export function parsePlan(value: unknown, now: string): LinearAgentPlan | string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("plan must be an array of 1 to 100 entries");
  }
  const entries = value.map((entry, index) => {
    const keys = isRecord(entry) ? Object.keys(entry) : [];
    if (
      !isRecord(entry) ||
      keys.some((key) => key !== "content" && key !== "status") ||
      typeof entry.content !== "string" ||
      entry.content.length < 1 ||
      entry.content.length > 10_000 ||
      !(PLAN_STATUSES as readonly unknown[]).includes(entry.status)
    ) {
      throw new Error(
        `plan[${index}] must contain only content (1 to 10000 characters) and status (${PLAN_STATUSES.join(", ")})`,
      );
    }
    return { content: entry.content as string, status: entry.status as LinearAgentPlanEntryStatus };
  });
  return { entries, updatedAt: now };
}

export function parseSummary(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error("summary must be 1 to 255 characters on one line");
  }
  return value;
}

function parseLinkList(value: unknown, field: string): LinearAgentExternalLink[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  const links = value.map((link, index) => {
    if (!isRecord(link) || typeof link.label !== "string" || typeof link.url !== "string" || !URL.canParse(link.url)) {
      throw new Error(`${field}[${index}] needs a label and a valid url`);
    }
    return { label: link.label, url: link.url };
  });
  if (new Set(links.map((link) => link.url)).size !== links.length) throw new Error(`${field} URLs must be unique`);
  return links;
}

export interface SessionLinks {
  external_link: string | null;
  external_links: LinearAgentExternalLink[];
}

/**
 * Applies the externalLink, externalUrls, addedExternalUrls, and removedExternalUrls inputs. externalUrls replaces the
 * list and cannot be combined with the incremental fields. Setting externalLink also adds it to the list, labeled with
 * the agent's name.
 */
export function applyExternalLinks(
  current: SessionLinks,
  input: Record<string, unknown>,
  agentName: string,
): SessionLinks {
  let links = [...current.external_links];
  let externalLink = current.external_link;
  const replacing = input.externalUrls !== undefined && input.externalUrls !== null;
  const added = input.addedExternalUrls ? parseLinkList(input.addedExternalUrls, "addedExternalUrls") : [];
  const removed =
    input.removedExternalUrls === undefined || input.removedExternalUrls === null ? [] : input.removedExternalUrls;
  if (!Array.isArray(removed) || removed.some((url) => typeof url !== "string")) {
    throw new Error("removedExternalUrls must be a list of URLs");
  }

  if (replacing) {
    if (added.length > 0 || removed.length > 0) {
      throw new Error("externalUrls cannot be combined with addedExternalUrls or removedExternalUrls");
    }
    links = parseLinkList(input.externalUrls, "externalUrls");
  } else {
    if (added.some((link) => removed.includes(link.url))) {
      throw new Error("A URL cannot be added and removed in the same request");
    }
    for (const link of added) {
      const index = links.findIndex((existing) => existing.url === link.url);
      if (index === -1) links.push(link);
      else links[index] = link;
    }
    links = links.filter((link) => !removed.includes(link.url));
  }

  if (input.externalLink !== undefined) {
    if (input.externalLink === null) {
      externalLink = null;
    } else if (typeof input.externalLink === "string" && URL.canParse(input.externalLink)) {
      externalLink = input.externalLink;
      if (!links.some((link) => link.url === externalLink)) links.push({ label: agentName, url: externalLink });
    } else {
      throw new Error("externalLink must be a valid URL");
    }
  }
  return { external_link: externalLink, external_links: links };
}

/**
 * The session changes that publishing an activity causes. A thought, action, or user prompt makes the session active,
 * an elicitation waits for input, a response completes the turn unless it carries continue, an error clears the plan,
 * and a stop prompt moves the session to stopping.
 */
export function sessionChangesForActivity(
  session: LinearAgentSession,
  content: LinearAgentActivityContent,
  signal: LinearAgentActivitySignal | null,
  now: string,
): Partial<LinearAgentSession> {
  const becomeActive = (): Partial<LinearAgentSession> =>
    session.status === "active" ? {} : { status: "active", started_at: now, ended_at: null };
  switch (content.type) {
    case "thought":
    case "action":
      return becomeActive();
    case "elicitation":
      return { status: "awaitingInput" };
    case "response":
      return signal === "continue" ? becomeActive() : { status: "complete", ended_at: now };
    case "error":
      return { status: "error", plan: null };
    case "prompt":
      return signal === "stop" ? { status: "stopping", ended_at: null } : becomeActive();
  }
}

/** The emulator's earlier session `state` values, derived from the status. */
export function legacySessionState(session: LinearAgentSession): string {
  if (session.dismissed_at) return "canceled";
  if (session.status === "pending") return "pending";
  if (session.status === "complete") return "completed";
  if (session.status === "error") return "failed";
  return "active";
}

/** Maps the emulator's earlier `state` input onto the session. */
export function legacyStateChanges(value: unknown, actor: LinearUser, now: string): Partial<LinearAgentSession> {
  switch (value) {
    case "pending":
      return { status: "pending", dismissed_at: null, dismissed_by_id: null };
    case "active":
      return { status: "active", started_at: now, ended_at: null, dismissed_at: null, dismissed_by_id: null };
    case "completed":
      return { status: "complete", ended_at: now };
    case "failed":
      return { status: "error", plan: null };
    case "canceled":
      return { status: "complete", ended_at: now, dismissed_at: now, dismissed_by_id: actor.linear_id };
    default:
      return {};
  }
}

export function userUrl(user: LinearUser): string {
  return `https://linear.app/user/${encodeURIComponent(user.email)}`;
}

function userChildPayload(user: LinearUser) {
  return { id: user.linear_id, name: user.name, email: user.email, avatarUrl: user.avatar_url, url: userUrl(user) };
}

function commentChildPayload(comment: LinearComment) {
  return {
    id: comment.linear_id,
    body: comment.body,
    userId: comment.user_id,
    issueId: comment.issue_id,
    documentContentId: null,
    initiativeUpdateId: null,
    projectUpdateId: null,
  };
}

/** AgentSessionWebhookPayload. */
export function agentSessionWebhookPayload(store: Store, session: LinearAgentSession) {
  const ls = getLinearStore(store);
  const issue = session.issue_id ? ls.issues.findOneBy("linear_id", session.issue_id) : undefined;
  const team = issue ? ls.teams.findOneBy("linear_id", issue.team_id) : undefined;
  const comment = session.comment_id ? ls.comments.findOneBy("linear_id", session.comment_id) : undefined;
  const creator = session.creator_id ? ls.users.findOneBy("linear_id", session.creator_id) : undefined;
  return {
    id: session.linear_id,
    appUserId: session.agent_user_id,
    organizationId: ls.organizations.all()[0]?.linear_id ?? null,
    issueId: session.issue_id,
    issue: issue
      ? {
          id: issue.linear_id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          url: issue.url,
          teamId: issue.team_id,
          team: team ? { id: team.linear_id, key: team.key, name: team.name } : null,
        }
      : null,
    commentId: session.comment_id,
    comment: comment ? commentChildPayload(comment) : null,
    creatorId: session.creator_id,
    creator: creator ? userChildPayload(creator) : null,
    sourceCommentId: null,
    sourceMetadata: null,
    status: session.status,
    type: "commentThread",
    summary: session.summary,
    url: issue?.url ?? null,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    archivedAt: session.archived_at,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

/** AgentActivityWebhookPayload. */
export function agentActivityWebhookPayload(store: Store, activity: LinearAgentActivity) {
  const user = getLinearStore(store).users.findOneBy("linear_id", activity.user_id);
  return {
    id: activity.linear_id,
    agentSessionId: activity.session_id,
    content: activity.content,
    signal: activity.signal,
    signalMetadata: activity.signal_metadata,
    sourceCommentId: null,
    userId: activity.user_id,
    user: user ? userChildPayload(user) : null,
    createdAt: activity.created_at,
    updatedAt: activity.updated_at,
    archivedAt: activity.archived_at,
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function promptTime(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

function commentXml(store: Store, comment: LinearComment): string {
  const author = comment.user_id ? getLinearStore(store).users.findOneBy("linear_id", comment.user_id) : undefined;
  return `<comment author="${escapeXml(author?.name ?? "Unknown")}" created-at="${promptTime(comment.created_at)}">${escapeXml(comment.body)}</comment>`;
}

/**
 * The promptContext of a `created` AgentSessionEvent: the issue, then the comment that started the session as the
 * primary directive thread, then the issue's other comments. Each emulated comment is its own thread.
 */
export function agentSessionPromptContext(store: Store, session: LinearAgentSession): string | null {
  const ls = getLinearStore(store);
  const issue = session.issue_id ? ls.issues.findOneBy("linear_id", session.issue_id) : undefined;
  if (!issue) return null;
  const team = ls.teams.findOneBy("linear_id", issue.team_id);
  const project = issue.project_id ? ls.projects.findOneBy("linear_id", issue.project_id) : undefined;
  const lines = [`<issue identifier="${escapeXml(issue.identifier)}">`, `<title>${escapeXml(issue.title)}</title>`];
  if (issue.description) lines.push(`<description>${escapeXml(issue.description)}</description>`);
  if (team) lines.push(`<team name="${escapeXml(team.name)}"/>`);
  for (const labelId of issue.label_ids) {
    const label = ls.issueLabels.findOneBy("linear_id", labelId);
    if (label) lines.push(`<label>${escapeXml(label.name)}</label>`);
  }
  if (project)
    lines.push(`<project name="${escapeXml(project.name)}">${escapeXml(project.description ?? "")}</project>`);
  lines.push("</issue>");

  const sections = [lines.join("\n")];
  const comments = [...ls.comments.findBy("issue_id", issue.linear_id)].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const directive = comments.find((comment) => comment.linear_id === session.comment_id);
  if (directive) {
    sections.push(
      `<primary-directive-thread comment-id="${directive.linear_id}">${commentXml(store, directive)}</primary-directive-thread>`,
    );
  }
  for (const comment of comments) {
    if (comment === directive) continue;
    sections.push(`<other-thread comment-id="${comment.linear_id}">\n${commentXml(store, comment)}\n</other-thread>`);
  }
  return sections.join("\n\n");
}

/** The OAuth app whose app user owns the session, for the event's oauthClientId. */
export function oauthClientIdForAgent(store: Store, agentUserId: string): string | null {
  return getLinearStore(store).oauthApps.findOneBy("app_user_id", agentUserId)?.linear_id ?? null;
}
