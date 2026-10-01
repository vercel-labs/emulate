import type {
  JiraBoard,
  JiraBoardType,
  JiraComponent,
  JiraIssue,
  JiraProject,
  JiraSprint,
  JiraVersion,
} from "./entities.js";
import { insertFrom, type JiraStore } from "./store.js";

export interface CreateProjectInput {
  key: string;
  name: string;
  description?: string;
  lead?: string | null;
  project_type_key?: JiraProject["project_type_key"];
  /** Status names in workflow order. Defaults to To Do, In Progress, Done. */
  statuses?: string[];
  /** Issue type names. Defaults to every issue type. */
  issue_types?: string[];
  /** Software projects get a scrum board unless this is false. */
  board?: boolean | { name?: string; type?: JiraBoardType };
}

/** Creates a project with its workflow statuses, issue types, and (for software projects) a board. */
export function createProject(js: JiraStore, input: CreateProjectInput): JiraProject {
  const byName = <T extends { id: number; name: string }>(items: T[], names: string[]) =>
    names
      .map((name) => items.find((item) => item.name.toLowerCase() === name.toLowerCase())?.id)
      .filter((id): id is number => id !== undefined);
  const project = insertFrom(js.projects, 10000, {
    key: input.key.toUpperCase(),
    name: input.name,
    description: input.description ?? "",
    lead_account_id: input.lead ?? null,
    project_type_key: input.project_type_key ?? "software",
    issue_sequence: 0,
    status_ids: byName(js.statuses.all(), input.statuses ?? ["To Do", "In Progress", "Done"]),
    issue_type_ids: byName(js.issueTypes.all(), input.issue_types ?? js.issueTypes.all().map((type) => type.name)),
  });
  if (input.board !== false && project.project_type_key === "software") {
    const board = typeof input.board === "object" ? input.board : {};
    js.boards.insert({
      name: board.name ?? `${project.key} board`,
      type: board.type ?? "scrum",
      project_id: project.id,
    });
  }
  return project;
}

/** Bumps an issue's `updated` timestamp after a change to something that hangs off it. */
export function touchIssue(js: JiraStore, issueId: number): void {
  js.issues.update(issueId, {});
}

/** Removes an issue and everything that hangs off it. Subtasks are removed too. */
export function deleteIssueRecord(js: JiraStore, issue: JiraIssue): void {
  for (const child of js.issues.findBy("parent_id", issue.id)) {
    if (js.issueTypes.get(child.issue_type_id)?.subtask) deleteIssueRecord(js, child);
    else js.issues.update(child.id, { parent_id: null });
  }
  for (const comment of js.comments.findBy("issue_id", issue.id)) js.comments.delete(comment.id);
  for (const entry of js.changelogs.findBy("issue_id", issue.id)) js.changelogs.delete(entry.id);
  for (const worklog of js.worklogs.findBy("issue_id", issue.id)) js.worklogs.delete(worklog.id);
  for (const link of [
    ...js.issueLinks.findBy("inward_issue_id", issue.id),
    ...js.issueLinks.findBy("outward_issue_id", issue.id),
  ]) {
    js.issueLinks.delete(link.id);
  }
  js.issues.delete(issue.id);
}

export function deleteProjectRecord(js: JiraStore, project: JiraProject): void {
  for (const issue of js.issues.findBy("project_id", project.id)) {
    if (js.issues.get(issue.id)) deleteIssueRecord(js, issue);
  }
  for (const component of js.components.findBy("project_id", project.id)) js.components.delete(component.id);
  for (const version of js.versions.findBy("project_id", project.id)) js.versions.delete(version.id);
  for (const board of js.boards.findBy("project_id", project.id)) deleteBoardRecord(js, board);
  js.projects.delete(project.id);
}

/** Removes a component and drops it from every issue that uses it. */
export function deleteComponentRecord(js: JiraStore, component: JiraComponent): void {
  for (const issue of js.issues.findBy("project_id", component.project_id)) {
    if (issue.component_ids.includes(component.id)) {
      js.issues.update(issue.id, { component_ids: issue.component_ids.filter((id) => id !== component.id) });
    }
  }
  js.components.delete(component.id);
}

/** Removes a version and drops it from every issue's fix versions. */
export function deleteVersionRecord(js: JiraStore, version: JiraVersion): void {
  for (const issue of js.issues.findBy("project_id", version.project_id)) {
    if (issue.fix_version_ids.includes(version.id)) {
      js.issues.update(issue.id, { fix_version_ids: issue.fix_version_ids.filter((id) => id !== version.id) });
    }
  }
  js.versions.delete(version.id);
}

/** Removes a sprint and detaches it from every issue, current or past. */
export function deleteSprintRecord(js: JiraStore, sprint: JiraSprint): void {
  for (const issue of js.issues.all()) {
    if (issue.sprint_id === sprint.id || issue.closed_sprint_ids.includes(sprint.id)) {
      js.issues.update(issue.id, {
        sprint_id: issue.sprint_id === sprint.id ? null : issue.sprint_id,
        closed_sprint_ids: issue.closed_sprint_ids.filter((id) => id !== sprint.id),
      });
    }
  }
  js.sprints.delete(sprint.id);
}

export function deleteBoardRecord(js: JiraStore, board: JiraBoard): void {
  for (const sprint of js.sprints.findBy("board_id", board.id)) deleteSprintRecord(js, sprint);
  js.boards.delete(board.id);
}
