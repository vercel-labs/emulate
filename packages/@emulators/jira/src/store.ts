import { Store, type Collection, type Entity, type InsertInput } from "@emulators/core";
import type {
  JiraApiToken,
  JiraBoard,
  JiraChangelog,
  JiraComment,
  JiraComponent,
  JiraCustomField,
  JiraIssue,
  JiraIssueLink,
  JiraIssueLinkType,
  JiraIssueType,
  JiraOAuthApp,
  JiraOAuthToken,
  JiraPriority,
  JiraProject,
  JiraResolution,
  JiraSite,
  JiraSprint,
  JiraStatus,
  JiraUser,
  JiraVersion,
  JiraWebhook,
  JiraWebhookDelivery,
  JiraWorklog,
} from "./entities.js";

export interface JiraStore {
  sites: Collection<JiraSite>;
  users: Collection<JiraUser>;
  apiTokens: Collection<JiraApiToken>;
  projects: Collection<JiraProject>;
  issueTypes: Collection<JiraIssueType>;
  statuses: Collection<JiraStatus>;
  priorities: Collection<JiraPriority>;
  resolutions: Collection<JiraResolution>;
  customFields: Collection<JiraCustomField>;
  issues: Collection<JiraIssue>;
  comments: Collection<JiraComment>;
  changelogs: Collection<JiraChangelog>;
  worklogs: Collection<JiraWorklog>;
  issueLinkTypes: Collection<JiraIssueLinkType>;
  issueLinks: Collection<JiraIssueLink>;
  components: Collection<JiraComponent>;
  versions: Collection<JiraVersion>;
  boards: Collection<JiraBoard>;
  sprints: Collection<JiraSprint>;
  webhooks: Collection<JiraWebhook>;
  webhookDeliveries: Collection<JiraWebhookDelivery>;
  oauthApps: Collection<JiraOAuthApp>;
  oauthTokens: Collection<JiraOAuthToken>;
}

export function getJiraStore(store: Store): JiraStore {
  return {
    sites: store.collection<JiraSite>("jira.sites", ["cloud_id"]),
    users: store.collection<JiraUser>("jira.users", ["account_id", "email"]),
    apiTokens: store.collection<JiraApiToken>("jira.api_tokens", ["token", "account_id"]),
    projects: store.collection<JiraProject>("jira.projects", ["key"]),
    issueTypes: store.collection<JiraIssueType>("jira.issue_types", ["name"]),
    statuses: store.collection<JiraStatus>("jira.statuses", ["name"]),
    priorities: store.collection<JiraPriority>("jira.priorities", ["name"]),
    resolutions: store.collection<JiraResolution>("jira.resolutions", ["name"]),
    customFields: store.collection<JiraCustomField>("jira.custom_fields", ["field_id"]),
    issues: store.collection<JiraIssue>("jira.issues", ["key", "project_id", "parent_id", "sprint_id"]),
    comments: store.collection<JiraComment>("jira.comments", ["issue_id"]),
    changelogs: store.collection<JiraChangelog>("jira.changelogs", ["issue_id"]),
    worklogs: store.collection<JiraWorklog>("jira.worklogs", ["issue_id"]),
    issueLinkTypes: store.collection<JiraIssueLinkType>("jira.issue_link_types", ["name"]),
    issueLinks: store.collection<JiraIssueLink>("jira.issue_links", ["inward_issue_id", "outward_issue_id"]),
    components: store.collection<JiraComponent>("jira.components", ["project_id"]),
    versions: store.collection<JiraVersion>("jira.versions", ["project_id"]),
    boards: store.collection<JiraBoard>("jira.boards", ["project_id"]),
    sprints: store.collection<JiraSprint>("jira.sprints", ["board_id"]),
    webhooks: store.collection<JiraWebhook>("jira.webhooks", []),
    webhookDeliveries: store.collection<JiraWebhookDelivery>("jira.webhook_deliveries", ["webhook_id"]),
    oauthApps: store.collection<JiraOAuthApp>("jira.oauth_apps", ["client_id"]),
    oauthTokens: store.collection<JiraOAuthToken>("jira.oauth_tokens", ["token"]),
  };
}

/**
 * Jira uses numeric string IDs that start at 10000 for most resources.
 * Inserting with an explicit ID moves the collection's auto ID forward, so
 * every later insert continues from there.
 */
export function insertFrom<T extends Entity>(collection: Collection<T>, base: number, data: InsertInput<T>): T {
  if (data.id != null) return collection.insert(data);
  const next = collection.snapshot().autoId;
  return collection.insert({ ...data, id: Math.max(next, base) });
}
