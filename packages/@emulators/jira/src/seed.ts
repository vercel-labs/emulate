import type { Store } from "@emulators/core";
import { getJiraStore, insertFrom } from "./store.js";
import { accountId } from "./ids.js";
import type { JiraBoardType, JiraCustomFieldType, JiraStatusCategory, JiraUser } from "./entities.js";
import { addComment, createIssue, createLink, systemActor } from "./issue-service.js";
import { findComponent, findIssue, findIssueType, findProject, findStatus, findUser, findVersion } from "./lookup.js";
import { WEBHOOK_EVENTS } from "./webhooks.js";
import { createProject, type CreateProjectInput } from "./services.js";
import { textToAdf } from "./adf.js";

export const DEFAULT_CLOUD_ID = "11111111-2222-4333-8444-555555555555";
export const DEFAULT_ADMIN_EMAIL = "admin@jira.local";
export const DEFAULT_DEV_EMAIL = "dev@jira.local";
export const DEFAULT_API_TOKEN = "jira_test_token";
export const DEFAULT_DEV_API_TOKEN = "jira_dev_token";
export const DEFAULT_OAUTH_CLIENT_ID = "jira_example_client_id";
export const DEFAULT_OAUTH_CLIENT_SECRET = "example_client_secret";
export const DEFAULT_OAUTH_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "manage:jira-project",
  "manage:jira-configuration",
  "manage:jira-webhook",
  "read:me",
  "offline_access",
];

export function seedDefaults(store: Store, baseUrl: string): void {
  const js = getJiraStore(store);

  if (!js.sites.all()[0]) js.sites.insert({ cloud_id: DEFAULT_CLOUD_ID, name: "emulate" });

  const admin = ensureUser(store, { email: DEFAULT_ADMIN_EMAIL, display_name: "Jira Admin", admin: true });
  const dev = ensureUser(store, { email: DEFAULT_DEV_EMAIL, display_name: "Developer" });
  ensureApiToken(store, admin.account_id, DEFAULT_API_TOKEN);
  ensureApiToken(store, dev.account_id, DEFAULT_DEV_API_TOKEN);

  const statusDefaults: Array<[string, JiraStatusCategory]> = [
    ["To Do", "new"],
    ["In Progress", "indeterminate"],
    ["Done", "done"],
  ];
  for (const [name, category] of statusDefaults) ensureStatus(store, name, category);

  const typeDefaults: Array<[string, string, boolean, number]> = [
    ["Epic", "A big user story that needs to be broken down.", false, 1],
    ["Story", "Functionality or a feature expressed as a user goal.", false, 0],
    ["Task", "A small, distinct piece of work.", false, 0],
    ["Bug", "A problem or error.", false, 0],
    ["Subtask", "A small piece of work that's part of a larger task.", true, -1],
  ];
  for (const [name, description, subtask, level] of typeDefaults) {
    if (!js.issueTypes.findOneBy("name", name)) {
      insertFrom(js.issueTypes, 10000, { name, description, subtask, hierarchy_level: level });
    }
  }

  const priorityDefaults: Array<[string, string, string]> = [
    ["Highest", "This problem will block progress.", "#d04437"],
    ["High", "Serious problem that could block progress.", "#f15C75"],
    ["Medium", "Has the potential to affect progress.", "#f79232"],
    ["Low", "Minor problem or easily worked around.", "#707070"],
    ["Lowest", "Trivial problem with little or no impact on progress.", "#999999"],
  ];
  for (const [name, description, color] of priorityDefaults) {
    if (!js.priorities.findOneBy("name", name)) insertFrom(js.priorities, 1, { name, description, color });
  }

  const resolutionDefaults: Array<[string, string]> = [
    ["Done", "Work has been completed on this issue."],
    ["Won't Do", "This issue won't be actioned."],
    ["Duplicate", "The problem is a duplicate of an existing issue."],
    ["Cannot Reproduce", "All attempts at reproducing this issue failed."],
  ];
  for (const [name, description] of resolutionDefaults) {
    if (!js.resolutions.findOneBy("name", name)) insertFrom(js.resolutions, 10000, { name, description });
  }

  const linkDefaults: Array<[string, string, string]> = [
    ["Blocks", "is blocked by", "blocks"],
    ["Cloners", "is cloned by", "clones"],
    ["Duplicate", "is duplicated by", "duplicates"],
    ["Relates", "relates to", "relates to"],
  ];
  for (const [name, inward, outward] of linkDefaults) {
    if (!js.issueLinkTypes.findOneBy("name", name)) insertFrom(js.issueLinkTypes, 10000, { name, inward, outward });
  }

  const fieldDefaults: Array<[string, string, "number" | "date" | "sprint"]> = [
    ["customfield_10015", "Start date", "date"],
    ["customfield_10016", "Story point estimate", "number"],
    ["customfield_10020", "Sprint", "sprint"],
  ];
  for (const [fieldId, name, type] of fieldDefaults) {
    if (!js.customFields.findOneBy("field_id", fieldId)) {
      js.customFields.insert({ field_id: fieldId, name, type, options: [] });
    }
  }

  const project = ensureProject(store, {
    key: "EMU",
    name: "Emulate",
    lead: admin.account_id,
    description: "Default emulated project",
  });

  const board = js.boards.findBy("project_id", project.id)[0];
  let sprint = board ? js.sprints.findBy("board_id", board.id)[0] : undefined;
  if (board && !sprint) {
    const start = new Date();
    const end = new Date(start.getTime() + 14 * 24 * 3600 * 1000);
    sprint = js.sprints.insert({
      board_id: board.id,
      name: "EMU Sprint 1",
      state: "active",
      goal: "Ship the emulator",
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      complete_date: null,
    });
  }

  if (!js.oauthApps.findOneBy("client_id", DEFAULT_OAUTH_CLIENT_ID)) {
    js.oauthApps.insert({
      client_id: DEFAULT_OAUTH_CLIENT_ID,
      client_secret: DEFAULT_OAUTH_CLIENT_SECRET,
      name: "My Jira App",
      redirect_uris: ["http://localhost:3000/api/auth/callback/atlassian"],
      scopes: [...DEFAULT_OAUTH_SCOPES],
    });
  }

  if (js.issues.all().length === 0) {
    const actor = systemActor(store, js, baseUrl, admin);
    const { issue } = createIssue(actor, {
      fields: {
        project: { key: project.key },
        issuetype: { name: "Task" },
        summary: "Ship Jira emulator",
        description: textToAdf("Use local Jira state in tests without calling the real Jira API."),
        assignee: { accountId: dev.account_id },
        labels: ["emulate"],
        ...(sprint ? { customfield_10020: sprint.id } : {}),
      },
    });
    addComment(actor, issue, textToAdf("This issue was seeded by the Jira emulator."));
  }
}

export function ensureUser(
  store: Store,
  input: {
    email: string;
    display_name?: string;
    account_id?: string;
    admin?: boolean;
    active?: boolean;
    account_type?: "atlassian" | "app" | "customer";
    time_zone?: string;
  },
) {
  const js = getJiraStore(store);
  const existing = js.users.all().find((user) => user.email.toLowerCase() === input.email.toLowerCase());
  if (existing) return existing;
  return js.users.insert({
    account_id: input.account_id ?? accountId(),
    email: input.email,
    display_name: input.display_name ?? input.email.split("@")[0],
    active: input.active ?? true,
    account_type: input.account_type ?? "atlassian",
    time_zone: input.time_zone ?? "Etc/UTC",
    locale: "en_US",
    admin: input.admin ?? false,
  });
}

export function ensureApiToken(store: Store, account: string, token: string, label = "emulate") {
  const js = getJiraStore(store);
  const existing = js.apiTokens.findOneBy("token", token);
  if (existing) return js.apiTokens.update(existing.id, { account_id: account })!;
  return js.apiTokens.insert({ token, account_id: account, label });
}

export function ensureStatus(store: Store, name: string, category: JiraStatusCategory, description = "") {
  const js = getJiraStore(store);
  const existing = js.statuses.all().find((status) => status.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return insertFrom(js.statuses, 10000, { name, category, description });
}

export function ensureProject(store: Store, input: CreateProjectInput) {
  const js = getJiraStore(store);
  return js.projects.findOneBy("key", input.key.toUpperCase()) ?? createProject(js, input);
}

export interface JiraSeedConfig {
  port?: number;
  baseUrl?: string;
  site?: { name?: string; cloud_id?: string };
  users?: Array<{
    email: string;
    display_name?: string;
    account_id?: string;
    admin?: boolean;
    active?: boolean;
    time_zone?: string;
    /** API token accepted for Basic auth (`email:token`) and as a bearer token. */
    api_token?: string;
  }>;
  statuses?: Array<{ name: string; category?: JiraStatusCategory; description?: string }>;
  issue_types?: Array<{ name: string; description?: string; subtask?: boolean; hierarchy_level?: number }>;
  custom_fields?: Array<{ id?: string; name: string; type: JiraCustomFieldType; options?: string[] }>;
  projects?: Array<{
    key: string;
    name: string;
    description?: string;
    lead?: string;
    type?: "software" | "business" | "service_desk";
    statuses?: string[];
    issue_types?: string[];
    components?: string[];
    versions?: Array<string | { name: string; released?: boolean; release_date?: string; description?: string }>;
    board?: boolean | { name?: string; type?: JiraBoardType };
  }>;
  sprints?: Array<{
    /** Project key or board name. */
    project?: string;
    board?: string;
    name: string;
    state?: "future" | "active" | "closed";
    goal?: string;
    start_date?: string;
    end_date?: string;
  }>;
  issues?: Array<{
    project: string;
    summary: string;
    type?: string;
    description?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    reporter?: string;
    labels?: string[];
    /** Key or summary of the parent issue. */
    parent?: string;
    due_date?: string;
    components?: string[];
    fix_versions?: string[];
    sprint?: string;
    custom_fields?: Record<string, unknown>;
    comments?: Array<{ body: string; author?: string }>;
  }>;
  links?: Array<{ type: string; inward: string; outward: string }>;
  oauth_apps?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    scopes?: string[] | string;
  }>;
  webhooks?: Array<{
    name?: string;
    url: string;
    events?: string[];
    jql?: string;
    secret?: string;
    enabled?: boolean;
    exclude_body?: boolean;
  }>;
  strict_scopes?: boolean;
}

function inferCategory(name: string): JiraStatusCategory {
  const lower = name.toLowerCase();
  if (/(done|closed|resolved|complete|released|cancel)/.test(lower)) return "done";
  if (/(to do|todo|backlog|open|new|selected)/.test(lower)) return "new";
  return "indeterminate";
}

export function seedFromConfig(store: Store, baseUrl: string, config: JiraSeedConfig): void {
  const js = getJiraStore(store);

  if (config.site) {
    const site = js.sites.all()[0];
    const patch = {
      name: config.site.name ?? site?.name ?? "emulate",
      cloud_id: config.site.cloud_id ?? site?.cloud_id ?? DEFAULT_CLOUD_ID,
    };
    if (site) js.sites.update(site.id, patch);
    else js.sites.insert(patch);
  }

  for (const userCfg of config.users ?? []) {
    const user = ensureUser(store, userCfg);
    const patch: Partial<JiraUser> = {};
    if (userCfg.display_name) patch.display_name = userCfg.display_name;
    if (userCfg.admin !== undefined) patch.admin = userCfg.admin;
    if (userCfg.active !== undefined) patch.active = userCfg.active;
    if (Object.keys(patch).length > 0) js.users.update(user.id, patch);
    if (userCfg.api_token) ensureApiToken(store, user.account_id, userCfg.api_token);
  }
  const userRef = (ref: string | undefined) => (ref ? findUser(js, ref)?.account_id : undefined);

  for (const statusCfg of config.statuses ?? []) {
    ensureStatus(store, statusCfg.name, statusCfg.category ?? inferCategory(statusCfg.name), statusCfg.description);
  }

  for (const typeCfg of config.issue_types ?? []) {
    if (findIssueType(js, typeCfg.name)) continue;
    insertFrom(js.issueTypes, 10000, {
      name: typeCfg.name,
      description: typeCfg.description ?? "",
      subtask: typeCfg.subtask ?? false,
      hierarchy_level: typeCfg.hierarchy_level ?? (typeCfg.subtask ? -1 : 0),
    });
  }

  for (const fieldCfg of config.custom_fields ?? []) {
    if (js.customFields.all().some((field) => field.name === fieldCfg.name || field.field_id === fieldCfg.id)) continue;
    const used = js.customFields.all().map((field) => Number(field.field_id.replace("customfield_", "")));
    const fieldId = fieldCfg.id ?? `customfield_${Math.max(10099, ...used) + 1}`;
    js.customFields.insert({
      field_id: fieldId,
      name: fieldCfg.name,
      type: fieldCfg.type,
      options: fieldCfg.options ?? [],
    });
  }

  for (const projectCfg of config.projects ?? []) {
    for (const name of projectCfg.statuses ?? []) ensureStatus(store, name, inferCategory(name));
    const project = ensureProject(store, {
      key: projectCfg.key,
      name: projectCfg.name,
      description: projectCfg.description,
      lead: userRef(projectCfg.lead) ?? js.users.all().find((user) => user.admin)?.account_id ?? null,
      project_type_key: projectCfg.type,
      statuses: projectCfg.statuses,
      issue_types: projectCfg.issue_types,
      board: projectCfg.board,
    });
    for (const name of projectCfg.components ?? []) {
      if (findComponent(js, project.id, { name })) continue;
      insertFrom(js.components, 10000, { project_id: project.id, name, description: "", lead_account_id: null });
    }
    for (const versionCfg of projectCfg.versions ?? []) {
      const version = typeof versionCfg === "string" ? { name: versionCfg } : versionCfg;
      if (findVersion(js, project.id, { name: version.name })) continue;
      insertFrom(js.versions, 10000, {
        project_id: project.id,
        name: version.name,
        description: "description" in version ? (version.description ?? "") : "",
        released: "released" in version ? (version.released ?? false) : false,
        archived: false,
        start_date: null,
        release_date: "release_date" in version ? (version.release_date ?? null) : null,
      });
    }
  }

  for (const sprintCfg of config.sprints ?? []) {
    const project = sprintCfg.project ? findProject(js, sprintCfg.project) : undefined;
    const board = sprintCfg.board
      ? js.boards.all().find((b) => b.name === sprintCfg.board)
      : project
        ? js.boards.findBy("project_id", project.id).find((b) => b.type === "scrum")
        : undefined;
    if (!board || js.sprints.findBy("board_id", board.id).some((sprint) => sprint.name === sprintCfg.name)) continue;
    const state = sprintCfg.state ?? "future";
    const start = sprintCfg.start_date ?? (state === "future" ? null : new Date().toISOString());
    const end =
      sprintCfg.end_date ?? (start ? new Date(new Date(start).getTime() + 14 * 24 * 3600 * 1000).toISOString() : null);
    js.sprints.insert({
      board_id: board.id,
      name: sprintCfg.name,
      state,
      goal: sprintCfg.goal ?? "",
      start_date: start,
      end_date: end,
      complete_date: state === "closed" ? (end ?? new Date().toISOString()) : null,
    });
  }

  const findIssueRef = (ref: string | undefined, projectId?: number) => {
    if (!ref) return undefined;
    return (
      findIssue(js, ref) ??
      js.issues
        .all()
        .find((issue) => issue.summary === ref && (projectId === undefined || issue.project_id === projectId))
    );
  };

  const sprintField = js.customFields.all().find((field) => field.type === "sprint")?.field_id;
  for (const issueCfg of config.issues ?? []) {
    const project = findProject(js, issueCfg.project);
    if (!project) continue;
    if (js.issues.findBy("project_id", project.id).some((issue) => issue.summary === issueCfg.summary)) continue;
    const reporter =
      findUser(js, issueCfg.reporter ?? "") ?? js.users.all().find((user) => user.admin) ?? js.users.all()[0];
    const actor = systemActor(store, js, baseUrl, reporter);
    const parent = findIssueRef(issueCfg.parent, project.id);
    const sprint = issueCfg.sprint
      ? js.sprints.all().find((s) => s.name === issueCfg.sprint || String(s.id) === issueCfg.sprint)
      : undefined;
    const fields: Record<string, unknown> = {
      project: { key: project.key },
      issuetype: { name: issueCfg.type ?? "Task" },
      summary: issueCfg.summary,
      ...(issueCfg.description !== undefined ? { description: textToAdf(issueCfg.description) } : {}),
      ...(issueCfg.priority ? { priority: { name: issueCfg.priority } } : {}),
      ...(issueCfg.assignee ? { assignee: { accountId: userRef(issueCfg.assignee) ?? issueCfg.assignee } } : {}),
      ...(issueCfg.labels ? { labels: issueCfg.labels } : {}),
      ...(parent ? { parent: { key: parent.key } } : {}),
      ...(issueCfg.due_date ? { duedate: issueCfg.due_date } : {}),
      ...(issueCfg.components ? { components: issueCfg.components.map((name) => ({ name })) } : {}),
      ...(issueCfg.fix_versions ? { fixVersions: issueCfg.fix_versions.map((name) => ({ name })) } : {}),
      // Closed sprints cannot take new issues, so they are recorded as sprint history below.
      ...(sprint && sprintField && sprint.state !== "closed" ? { [sprintField]: sprint.id } : {}),
      ...(issueCfg.custom_fields ?? {}),
    };
    const { issue } = createIssue(actor, { fields });
    if (sprint?.state === "closed") js.issues.update(issue.id, { closed_sprint_ids: [sprint.id] });
    if (issueCfg.status) {
      const status = findStatus(js, issueCfg.status);
      if (status && project.status_ids.includes(status.id)) {
        const done = status.category === "done";
        js.issues.update(issue.id, {
          status_id: status.id,
          resolution_id: done ? (js.resolutions.findOneBy("name", "Done")?.id ?? null) : null,
          resolution_date: done ? new Date().toISOString() : null,
        });
      }
    }
    for (const commentCfg of issueCfg.comments ?? []) {
      const author = findUser(js, commentCfg.author ?? "") ?? reporter;
      addComment(systemActor(store, js, baseUrl, author), js.issues.get(issue.id)!, textToAdf(commentCfg.body));
    }
  }

  for (const linkCfg of config.links ?? []) {
    const type = js.issueLinkTypes.all().find((t) => t.name.toLowerCase() === linkCfg.type.toLowerCase());
    const inward = findIssueRef(linkCfg.inward);
    const outward = findIssueRef(linkCfg.outward);
    if (type && inward && outward) createLink(js, type.id, inward.id, outward.id);
  }

  for (const appCfg of config.oauth_apps ?? []) {
    const scopes = Array.isArray(appCfg.scopes)
      ? appCfg.scopes
      : appCfg.scopes
        ? appCfg.scopes.split(/[\s,]+/).filter(Boolean)
        : [...DEFAULT_OAUTH_SCOPES];
    const data = {
      client_secret: appCfg.client_secret,
      name: appCfg.name,
      redirect_uris: appCfg.redirect_uris,
      scopes,
    };
    const existing = js.oauthApps.findOneBy("client_id", appCfg.client_id);
    if (existing) js.oauthApps.update(existing.id, data);
    else js.oauthApps.insert({ client_id: appCfg.client_id, ...data });
  }

  for (const hookCfg of config.webhooks ?? []) {
    if (js.webhooks.all().some((hook) => hook.url === hookCfg.url && hook.name === (hookCfg.name ?? "Webhook")))
      continue;
    insertFrom(js.webhooks, 1, {
      name: hookCfg.name ?? "Webhook",
      url: hookCfg.url,
      events: hookCfg.events ?? [...WEBHOOK_EVENTS],
      jql_filter: hookCfg.jql ?? null,
      enabled: hookCfg.enabled ?? true,
      exclude_body: hookCfg.exclude_body ?? false,
      secret: hookCfg.secret ?? null,
      kind: "admin",
      client_id: null,
      expiration_date: null,
    });
  }

  if (config.strict_scopes !== undefined) store.setData("jira.strict_scopes", config.strict_scopes);
}
