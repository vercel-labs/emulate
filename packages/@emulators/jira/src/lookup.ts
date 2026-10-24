import type { Collection, Entity } from "@emulators/core";
import type { JiraStore } from "./store.js";
import { JiraError, issueNotFound, type PageParams } from "./context.js";

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asId = (ref: string | number) => (/^\d+$/.test(String(ref)) ? Number(ref) : undefined);

type Ref = string | number | undefined | null;

/** Looks an entity up by numeric id, or else by a case-insensitive name. */
function findByIdOrName<T extends Entity>(collection: Collection<T>, ref: Ref, names: (item: T) => string[]) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  if (id !== undefined) return collection.get(id);
  return collection.all().find((item) => names(item).some((name) => eqi(name, String(ref))));
}

/** Project keys are stored uppercase, so key lookups use the index. */
export function findProject(js: JiraStore, ref: Ref) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  return id !== undefined ? js.projects.get(id) : js.projects.findOneBy("key", String(ref).toUpperCase());
}

export function requireProject(js: JiraStore, ref: string) {
  const project = findProject(js, ref);
  if (!project) throw new JiraError(404, [`No project could be found with key '${ref}'.`]);
  return project;
}

/** Issue keys inherit the uppercase project key, so key lookups use the index. */
export function findIssue(js: JiraStore, ref: Ref) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const id = asId(ref);
  return id !== undefined ? js.issues.get(id) : js.issues.findOneBy("key", String(ref).toUpperCase());
}

export function requireIssue(js: JiraStore, ref: string) {
  const issue = findIssue(js, ref);
  if (!issue) throw issueNotFound();
  return issue;
}

export function findUser(js: JiraStore, ref: string | undefined | null) {
  if (!ref) return undefined;
  return (
    js.users.findOneBy("account_id", ref) ??
    js.users.all().find((user) => eqi(user.email, ref) || eqi(user.display_name, ref))
  );
}

export const findIssueType = (js: JiraStore, ref: Ref) => findByIdOrName(js.issueTypes, ref, (type) => [type.name]);
export const findStatus = (js: JiraStore, ref: Ref) => findByIdOrName(js.statuses, ref, (status) => [status.name]);
export const findPriority = (js: JiraStore, ref: Ref) =>
  findByIdOrName(js.priorities, ref, (priority) => [priority.name]);
export const findResolution = (js: JiraStore, ref: Ref) =>
  findByIdOrName(js.resolutions, ref, (resolution) => [resolution.name]);

export function findComponent(js: JiraStore, projectId: number, ref: { id?: string | number; name?: string }) {
  const components = js.components.findBy("project_id", projectId);
  if (ref.id !== undefined) return components.find((component) => component.id === Number(ref.id));
  if (ref.name) return components.find((component) => eqi(component.name, ref.name!));
  return undefined;
}

export function findVersion(js: JiraStore, projectId: number, ref: { id?: string | number; name?: string }) {
  const versions = js.versions.findBy("project_id", projectId);
  if (ref.id !== undefined) return versions.find((version) => version.id === Number(ref.id));
  if (ref.name) return versions.find((version) => eqi(version.name, ref.name!));
  return undefined;
}

export function paginate<T>(items: T[], { startAt, maxResults }: PageParams) {
  const values = items.slice(startAt, startAt + maxResults);
  return {
    startAt,
    maxResults,
    total: items.length,
    isLast: startAt + values.length >= items.length,
    values,
  };
}
