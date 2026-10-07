import type {
  AdfNode,
  JiraCustomField,
  JiraChangelog,
  JiraComment,
  JiraIssue,
  JiraSprint,
  JiraStatus,
  JiraWorklog,
} from "./entities.js";
import { adfToHtml, adfToText } from "./adf.js";
import { allFields } from "./fields.js";
import {
  formatComponent,
  formatIssueType,
  formatPriority,
  formatProjectRef,
  formatResolution,
  formatStatus,
  formatUserById,
  formatVersion,
  projectStatuses,
  restUrl,
  type Fmt,
} from "./formatters.js";
import { jiraTime } from "./ids.js";

export function formatBody(r: Fmt, doc: AdfNode | null): AdfNode | string | null {
  if (!doc) return null;
  return r.version === "2" ? adfToText(doc) : doc;
}

export function issueSelf(r: Fmt, issue: JiraIssue): string {
  return restUrl(r, `/issue/${issue.id}`);
}

export function formatIssueRef(r: Fmt, issue: JiraIssue) {
  return {
    id: String(issue.id),
    key: issue.key,
    self: issueSelf(r, issue),
    fields: {
      summary: issue.summary,
      status: formatStatus(r, r.js.statuses.get(issue.status_id)),
      priority: formatPriority(r, issue.priority_id ? r.js.priorities.get(issue.priority_id) : null),
      issuetype: formatIssueType(r, r.js.issueTypes.get(issue.issue_type_id)),
    },
  };
}

export function formatComment(r: Fmt, comment: JiraComment) {
  return {
    self: restUrl(r, `/issue/${comment.issue_id}/comment/${comment.id}`),
    id: String(comment.id),
    author: formatUserById(r, comment.author_id),
    body: formatBody(r, comment.body),
    updateAuthor: formatUserById(r, comment.update_author_id ?? comment.author_id),
    created: jiraTime(comment.created_at),
    updated: jiraTime(comment.updated_at),
    jsdPublic: true,
  };
}

export function formatWorklog(r: Fmt, worklog: JiraWorklog) {
  return {
    self: restUrl(r, `/issue/${worklog.issue_id}/worklog/${worklog.id}`),
    author: formatUserById(r, worklog.author_id),
    updateAuthor: formatUserById(r, worklog.update_author_id ?? worklog.author_id),
    ...(worklog.comment ? { comment: formatBody(r, worklog.comment) } : {}),
    created: jiraTime(worklog.created_at),
    updated: jiraTime(worklog.updated_at),
    started: jiraTime(worklog.started),
    timeSpent: formatDuration(worklog.time_spent_seconds),
    timeSpentSeconds: worklog.time_spent_seconds,
    id: String(worklog.id),
    issueId: String(worklog.issue_id),
  };
}

export function formatSprint(r: Fmt, sprint: JiraSprint) {
  return {
    id: sprint.id,
    self: `${r.siteUrl}/rest/agile/1.0/sprint/${sprint.id}`,
    state: sprint.state,
    name: sprint.name,
    ...(sprint.start_date ? { startDate: sprint.start_date } : {}),
    ...(sprint.end_date ? { endDate: sprint.end_date } : {}),
    ...(sprint.complete_date ? { completeDate: sprint.complete_date } : {}),
    createdDate: sprint.created_at,
    originBoardId: sprint.board_id,
    boardId: sprint.board_id,
    goal: sprint.goal,
  };
}

export function formatChangelog(r: Fmt, entry: JiraChangelog) {
  return {
    id: String(entry.id),
    author: formatUserById(r, entry.author_id),
    created: jiraTime(entry.created_at),
    items: entry.items,
  };
}

/** Jira's default time tracking units, largest first: a week is 5 days and a day is 8 hours. */
const DURATION_UNITS = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };

/** Formats seconds as Jira does, such as `1w 2d 3h 30m`. */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  let remaining = seconds;
  for (const [unit, size] of Object.entries(DURATION_UNITS)) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      remaining -= count * size;
    }
  }
  return parts.join(" ") || "0m";
}

/** Parses Jira durations such as `1w 2d 3h 30m`. A bare number means minutes. */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 60;
  const parts = trimmed.split(/\s+/);
  let total = 0;
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)([wdhm])$/.exec(part);
    if (!match) return null;
    total += Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS];
  }
  return total > 0 ? Math.round(total) : null;
}

/** Transition IDs are derived from the status position in the project workflow (11, 21, 31, ...). */
export function issueTransitions(r: Fmt, issue: JiraIssue) {
  const project = r.js.projects.get(issue.project_id);
  if (!project) return [];
  return projectStatuses(r, project)
    .map((status, index) => ({ id: String((index + 1) * 10 + 1), status }))
    .filter((entry) => entry.status.id !== issue.status_id);
}

export function formatTransition(r: Fmt, transition: { id: string; status: JiraStatus }) {
  return {
    id: transition.id,
    name: transition.status.name,
    to: formatStatus(r, transition.status),
    hasScreen: false,
    isGlobal: true,
    isInitial: false,
    isAvailable: true,
    isConditional: false,
    isLooped: false,
  };
}

export interface FieldSelection {
  all: boolean;
  include: Set<string>;
  exclude: Set<string>;
}

/** Parses Jira's `fields` parameter: `*all`, `*navigable`, `summary,status`, `-comment`. */
export function parseFieldSelection(values: string[], defaultAll: boolean): FieldSelection {
  const include = new Set<string>();
  const exclude = new Set<string>();
  let all = false;
  let sawInclude = false;
  for (const value of values) {
    if (value === "*all" || value === "*navigable") {
      all = true;
      sawInclude = true;
    } else if (value.startsWith("-")) {
      exclude.add(value.slice(1));
    } else {
      include.add(value);
      sawInclude = true;
    }
  }
  if (!sawInclude) all = defaultAll;
  return { all, include, exclude };
}

export interface IssueFormatOptions {
  fields?: FieldSelection;
  expand?: string[];
}

/** Formats an issue's links from its own side: each entry names the other issue after its role. */
function formatIssueLinks(r: Fmt, issue: JiraIssue) {
  const js = r.js;
  return [...js.issueLinks.findBy("inward_issue_id", issue.id), ...js.issueLinks.findBy("outward_issue_id", issue.id)]
    .sort((a, b) => a.id - b.id)
    .map((link) => {
      const type = js.issueLinkTypes.get(link.type_id);
      // A link's outward issue is its source: "B blocks A" is stored as outward B, inward A.
      // Each side names the other issue after its own role, so B shows outwardIssue A and A shows inwardIssue B.
      const isSource = link.outward_issue_id === issue.id;
      const other = js.issues.get(isSource ? link.inward_issue_id : link.outward_issue_id);
      return {
        id: String(link.id),
        self: restUrl(r, `/issueLink/${link.id}`),
        type: type
          ? {
              id: String(type.id),
              name: type.name,
              inward: type.inward,
              outward: type.outward,
              self: restUrl(r, `/issueLinkType/${type.id}`),
            }
          : null,
        ...(other ? { [isSource ? "outwardIssue" : "inwardIssue"]: formatIssueRef(r, other) } : {}),
      };
    });
}

/**
 * Getters for every field of an issue, in Jira's response order. They are lazy so a request for a few
 * fields (search with `fields=key,summary`) does not load comments, worklogs, and links for every issue.
 */
export function issueFieldGetters(r: Fmt, issue: JiraIssue): Record<string, () => unknown> {
  const js = r.js;
  const worklogs = () => js.worklogs.findBy("issue_id", issue.id).sort((a, b) => a.id - b.id);
  const timeSpent = () => worklogs().reduce((sum, worklog) => sum + worklog.time_spent_seconds, 0) || null;
  const parent = issue.parent_id ? js.issues.get(issue.parent_id) : undefined;

  const getters: Record<string, () => unknown> = {
    statuscategorychangedate: () => jiraTime(issue.status_changed_at),
    issuetype: () => formatIssueType(r, js.issueTypes.get(issue.issue_type_id)),
    timespent: timeSpent,
    aggregatetimespent: timeSpent,
    project: () => formatProjectRef(r, js.projects.get(issue.project_id)),
    fixVersions: () =>
      issue.fix_version_ids
        .map((id) => js.versions.get(id))
        .filter(Boolean)
        .map((version) => formatVersion(r, version!)),
    resolution: () => formatResolution(r, issue.resolution_id ? js.resolutions.get(issue.resolution_id) : null),
    resolutiondate: () => jiraTime(issue.resolution_date),
    workratio: () => -1,
    watches: () => ({
      self: restUrl(r, `/issue/${issue.key}/watchers`),
      watchCount: issue.watcher_ids.length,
      isWatching: r.user ? issue.watcher_ids.includes(r.user.account_id) : false,
    }),
    lastViewed: () => null,
    created: () => jiraTime(issue.created_at),
    priority: () => formatPriority(r, issue.priority_id ? js.priorities.get(issue.priority_id) : null),
    labels: () => [...issue.labels],
    summary: () => issue.summary,
    issuelinks: () => formatIssueLinks(r, issue),
    assignee: () => formatUserById(r, issue.assignee_id),
    updated: () => jiraTime(issue.updated_at),
    status: () => formatStatus(r, js.statuses.get(issue.status_id)),
    components: () =>
      issue.component_ids
        .map((id) => js.components.get(id))
        .filter(Boolean)
        .map((component) => formatComponent(r, component!)),
    description: () => formatBody(r, issue.description),
    environment: () => formatBody(r, issue.environment),
    duedate: () => issue.due_date,
    creator: () => formatUserById(r, issue.creator_id),
    reporter: () => formatUserById(r, issue.reporter_id),
    subtasks: () =>
      js.issues
        .findBy("parent_id", issue.id)
        .filter((child) => js.issueTypes.get(child.issue_type_id)?.subtask)
        .sort((a, b) => a.id - b.id)
        .map((child) => formatIssueRef(r, child)),
    ...(parent ? { parent: () => formatIssueRef(r, parent) } : {}),
    comment: () => {
      const comments = js.comments.findBy("issue_id", issue.id).sort((a, b) => a.id - b.id);
      return {
        comments: comments.map((comment) => formatComment(r, comment)),
        self: restUrl(r, `/issue/${issue.id}/comment`),
        maxResults: comments.length,
        total: comments.length,
        startAt: 0,
      };
    },
    worklog: () => {
      const all = worklogs();
      return {
        startAt: 0,
        maxResults: 20,
        total: all.length,
        worklogs: all.slice(0, 20).map((worklog) => formatWorklog(r, worklog)),
      };
    },
    votes: () => ({ self: restUrl(r, `/issue/${issue.key}/votes`), votes: 0, hasVoted: false }),
  };

  for (const field of js.customFields.all()) {
    getters[field.field_id] = () => customFieldValue(r, issue, field);
  }
  return getters;
}

function customFieldValue(r: Fmt, issue: JiraIssue, field: JiraCustomField): unknown {
  const value = issue.custom_fields[field.field_id];
  switch (field.type) {
    case "sprint": {
      const sprints = [...issue.closed_sprint_ids, ...(issue.sprint_id ? [issue.sprint_id] : [])]
        .map((id) => r.js.sprints.get(id))
        .filter(Boolean)
        .map((sprint) => formatSprint(r, sprint!));
      return sprints.length > 0 ? sprints : null;
    }
    case "user":
      return formatUserById(r, value as string | null);
    case "option":
      return value == null ? null : { self: restUrl(r, `/customFieldOption/${field.id}`), value, id: String(field.id) };
    default:
      return value ?? null;
  }
}

export function formatIssue(r: Fmt, issue: JiraIssue, opts: IssueFormatOptions = {}) {
  const selection = opts.fields ?? { all: true, include: new Set<string>(), exclude: new Set<string>() };
  const expand = new Set(opts.expand ?? []);
  const fields: Record<string, unknown> = {};
  for (const [key, get] of Object.entries(issueFieldGetters(r, issue))) {
    if (selection.exclude.has(key)) continue;
    if (selection.all || selection.include.has(key)) fields[key] = get();
  }

  const result: Record<string, unknown> = {
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id: String(issue.id),
    self: issueSelf(r, issue),
    key: issue.key,
    fields,
  };

  if (expand.has("renderedFields")) {
    result.renderedFields = {
      description: adfToHtml(issue.description),
      environment: adfToHtml(issue.environment),
      created: issue.created_at,
      updated: issue.updated_at,
    };
  }
  if (expand.has("names") || expand.has("schema")) {
    const defs = allFields(r.js);
    if (expand.has("names")) result.names = Object.fromEntries(defs.map((field) => [field.id, field.name]));
    if (expand.has("schema")) result.schema = Object.fromEntries(defs.map((field) => [field.id, field.schema]));
  }
  if (expand.has("transitions")) {
    result.transitions = issueTransitions(r, issue).map((transition) => formatTransition(r, transition));
  }
  if (expand.has("changelog")) {
    const histories = r.js.changelogs
      .findBy("issue_id", issue.id)
      .sort((a, b) => a.id - b.id)
      .map((entry) => formatChangelog(r, entry));
    result.changelog = { startAt: 0, maxResults: histories.length, total: histories.length, histories };
  }
  return result;
}
