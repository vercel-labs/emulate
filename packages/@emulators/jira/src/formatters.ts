import type {
  JiraComponent,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraResolution,
  JiraStatus,
  JiraStatusCategory,
  JiraUser,
  JiraVersion,
} from "./entities.js";
import type { JiraRequest } from "./context.js";

export type Fmt = Pick<JiraRequest, "siteUrl" | "version" | "js" | "baseUrl"> & { user?: JiraUser };

export function restUrl(r: Fmt, path: string): string {
  return `${r.siteUrl}/rest/api/${r.version}${path}`;
}

export function avatarUrls(seed: string) {
  const url = (size: number) =>
    `https://avatar-management.services.atlassian.com/default/${size}?seed=${encodeURIComponent(seed)}`;
  return { "48x48": url(48), "24x24": url(24), "16x16": url(16), "32x32": url(32) };
}

export function formatUser(r: Fmt, user: JiraUser | undefined | null) {
  if (!user) return null;
  return {
    self: restUrl(r, `/user?accountId=${user.account_id}`),
    accountId: user.account_id,
    accountType: user.account_type,
    emailAddress: user.email,
    avatarUrls: avatarUrls(user.account_id),
    displayName: user.display_name,
    active: user.active,
    timeZone: user.time_zone,
    locale: user.locale,
  };
}

export function formatUserById(r: Fmt, accountId: string | null | undefined) {
  if (!accountId) return null;
  return formatUser(r, r.js.users.findOneBy("account_id", accountId));
}

const CATEGORY_INFO: Record<JiraStatusCategory, { id: number; name: string; colorName: string }> = {
  new: { id: 2, name: "To Do", colorName: "blue-gray" },
  indeterminate: { id: 4, name: "In Progress", colorName: "yellow" },
  done: { id: 3, name: "Done", colorName: "green" },
};

export function formatStatusCategory(r: Fmt, category: JiraStatusCategory) {
  const info = CATEGORY_INFO[category];
  return {
    self: restUrl(r, `/statuscategory/${info.id}`),
    id: info.id,
    key: category,
    colorName: info.colorName,
    name: info.name,
  };
}

export function allStatusCategories(r: Fmt) {
  return [
    { self: restUrl(r, "/statuscategory/1"), id: 1, key: "undefined", colorName: "medium-gray", name: "No Category" },
    ...(["new", "done", "indeterminate"] as const).map((key) => formatStatusCategory(r, key)),
  ];
}

export function formatStatus(r: Fmt, status: JiraStatus | undefined) {
  if (!status) return null;
  return {
    self: restUrl(r, `/status/${status.id}`),
    description: status.description,
    iconUrl: `${r.siteUrl}/images/icons/statuses/generic.png`,
    name: status.name,
    id: String(status.id),
    statusCategory: formatStatusCategory(r, status.category),
  };
}

export function formatIssueType(r: Fmt, type: JiraIssueType | undefined) {
  if (!type) return null;
  return {
    self: restUrl(r, `/issuetype/${type.id}`),
    id: String(type.id),
    description: type.description,
    iconUrl: `${r.siteUrl}/images/icons/issuetypes/${type.name.toLowerCase().replace(/[^a-z]/g, "")}.svg`,
    name: type.name,
    subtask: type.subtask,
    avatarId: 10300 + type.id - 10000,
    hierarchyLevel: type.hierarchy_level,
  };
}

export function formatPriority(r: Fmt, priority: JiraPriority | undefined | null) {
  if (!priority) return null;
  return {
    self: restUrl(r, `/priority/${priority.id}`),
    iconUrl: `${r.siteUrl}/images/icons/priorities/${priority.name.toLowerCase()}.svg`,
    name: priority.name,
    id: String(priority.id),
  };
}

export function formatPriorityFull(r: Fmt, priority: JiraPriority) {
  return {
    ...formatPriority(r, priority),
    statusColor: priority.color,
    description: priority.description,
    isDefault: priority.name === "Medium",
  };
}

export function formatResolution(r: Fmt, resolution: JiraResolution | undefined | null) {
  if (!resolution) return null;
  return {
    self: restUrl(r, `/resolution/${resolution.id}`),
    id: String(resolution.id),
    description: resolution.description,
    name: resolution.name,
  };
}

export function formatProjectRef(r: Fmt, project: JiraProject | undefined) {
  if (!project) return null;
  return {
    self: restUrl(r, `/project/${project.id}`),
    id: String(project.id),
    key: project.key,
    name: project.name,
    projectTypeKey: project.project_type_key,
    simplified: true,
    avatarUrls: avatarUrls(`project-${project.key}`),
  };
}

export function formatComponent(r: Fmt, component: JiraComponent) {
  const project = r.js.projects.get(component.project_id);
  return {
    self: restUrl(r, `/component/${component.id}`),
    id: String(component.id),
    name: component.name,
    description: component.description,
    lead: formatUserById(r, component.lead_account_id) ?? undefined,
    assigneeType: "PROJECT_DEFAULT",
    project: project?.key,
    projectId: component.project_id,
  };
}

export function formatVersion(r: Fmt, version: JiraVersion) {
  return {
    self: restUrl(r, `/version/${version.id}`),
    id: String(version.id),
    name: version.name,
    description: version.description,
    archived: version.archived,
    released: version.released,
    ...(version.start_date ? { startDate: version.start_date } : {}),
    ...(version.release_date ? { releaseDate: version.release_date } : {}),
    projectId: version.project_id,
  };
}

export function projectIssueTypes(r: Fmt, project: JiraProject) {
  return project.issue_type_ids
    .map((id) => r.js.issueTypes.get(id))
    .filter((type): type is JiraIssueType => Boolean(type));
}

export function projectStatuses(r: Fmt, project: JiraProject) {
  return project.status_ids
    .map((id) => r.js.statuses.get(id))
    .filter((status): status is JiraStatus => Boolean(status));
}

export function formatProject(r: Fmt, project: JiraProject) {
  return {
    expand: "description,lead,issueTypes,url,projectKeys,permissions,insight",
    ...formatProjectRef(r, project),
    description: project.description,
    lead: formatUserById(r, project.lead_account_id),
    components: r.js.components.findBy("project_id", project.id).map((component) => formatComponent(r, component)),
    issueTypes: projectIssueTypes(r, project).map((type) => formatIssueType(r, type)),
    assigneeType: "UNASSIGNED",
    versions: r.js.versions.findBy("project_id", project.id).map((version) => formatVersion(r, version)),
    roles: {},
    style: "next-gen",
    isPrivate: false,
    properties: {},
  };
}
