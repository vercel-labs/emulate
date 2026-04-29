import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { generateLinearId, slugify } from "./helpers.js";
import { getLinearStore } from "./store.js";
import { graphqlRoutes } from "./routes/graphql.js";
import type { LinearWorkflowStateType } from "./entities.js";

export { getLinearStore, type LinearStore } from "./store.js";
export * from "./entities.js";

export interface LinearSeedConfig {
  port?: number;
  api_keys?: string[];
  organizations?: Array<{
    id?: string;
    name: string;
    url_key?: string;
  }>;
  users?: Array<{
    id?: string;
    name: string;
    email: string;
    display_name?: string;
    active?: boolean;
    admin?: boolean;
    organization?: string;
  }>;
  teams?: Array<{
    id?: string;
    name: string;
    key: string;
    description?: string;
    organization?: string;
  }>;
  workflow_states?: Array<{
    id?: string;
    name: string;
    type?: LinearWorkflowStateType;
    position?: number;
    color?: string;
    team: string;
  }>;
  labels?: Array<{
    id?: string;
    name: string;
    color?: string;
    description?: string;
    team?: string;
  }>;
  projects?: Array<{
    id?: string;
    name: string;
    description?: string;
    slug_id?: string;
    state?: string;
    team?: string;
    lead?: string;
    target_date?: string;
  }>;
  issues?: Array<{
    id?: string;
    identifier?: string;
    number?: number;
    title: string;
    description?: string;
    priority?: number;
    estimate?: number;
    team: string;
    state?: string;
    assignee?: string;
    creator?: string;
    project?: string;
    labels?: string[];
  }>;
}

function insertApiKey(store: Store, key: string): void {
  const ls = getLinearStore(store);
  if (!ls.apiKeys.findOneBy("key", key)) {
    ls.apiKeys.insert({ key });
  }
}

function findOrganization(store: Store, ref: string | undefined) {
  const ls = getLinearStore(store);
  if (!ref) return ls.organizations.all()[0] ?? null;
  return (
    ls.organizations.findOneBy("linear_id", ref) ??
    ls.organizations.findOneBy("url_key", ref) ??
    ls.organizations.all().find((org) => org.name === ref) ??
    null
  );
}

function findTeam(store: Store, ref: string | undefined) {
  const ls = getLinearStore(store);
  if (!ref) return ls.teams.all()[0] ?? null;
  return (
    ls.teams.findOneBy("linear_id", ref) ??
    ls.teams.findOneBy("key", ref) ??
    ls.teams.all().find((team) => team.name === ref) ??
    null
  );
}

function findUser(store: Store, ref: string | undefined) {
  const ls = getLinearStore(store);
  if (!ref) return null;
  return (
    ls.users.findOneBy("linear_id", ref) ??
    ls.users.findOneBy("email", ref) ??
    ls.users.all().find((user) => user.name === ref) ??
    null
  );
}

function findWorkflowState(store: Store, ref: string | undefined) {
  const ls = getLinearStore(store);
  if (!ref) return null;
  return (
    ls.workflowStates.findOneBy("linear_id", ref) ?? ls.workflowStates.all().find((state) => state.name === ref) ?? null
  );
}

function findProject(store: Store, ref: string | undefined) {
  const ls = getLinearStore(store);
  if (!ref) return null;
  return (
    ls.projects.findOneBy("linear_id", ref) ??
    ls.projects.findOneBy("slug_id", ref) ??
    ls.projects.all().find((project) => project.name === ref) ??
    null
  );
}

function resolveLabelIds(store: Store, labels: string[] | undefined): string[] {
  if (!labels) return [];
  const ls = getLinearStore(store);
  return labels
    .map((ref) => ls.labels.findOneBy("linear_id", ref) ?? ls.labels.all().find((label) => label.name === ref))
    .filter((label): label is NonNullable<typeof label> => Boolean(label))
    .map((label) => label.linear_id);
}

function issueNumberForTeam(store: Store, teamId: string, requested?: number): number {
  if (requested !== undefined) return requested;
  const ls = getLinearStore(store);
  const highest = ls.issues.findBy("team_id", teamId).reduce((max, issue) => Math.max(max, issue.number), 0);
  return highest + 1;
}

function insertDefaults(store: Store, baseUrl: string): void {
  const ls = getLinearStore(store);
  insertApiKey(store, "lin_api_test");

  const orgId = "org-1";
  if (!ls.organizations.findOneBy("linear_id", orgId)) {
    ls.organizations.insert({ linear_id: orgId, name: "Emulate", url_key: "emulate" });
  }

  const userId = "user-1";
  if (!ls.users.findOneBy("linear_id", userId)) {
    ls.users.insert({
      linear_id: userId,
      name: "Developer",
      email: "dev@example.com",
      display_name: "Developer",
      active: true,
      admin: true,
      organization_id: orgId,
    });
  }

  const teamId = "team-1";
  if (!ls.teams.findOneBy("linear_id", teamId)) {
    ls.teams.insert({
      linear_id: teamId,
      name: "Engineering",
      key: "ENG",
      description: "Engineering work",
      organization_id: orgId,
    });
  }

  const todoStateId = "ws-1";
  if (!ls.workflowStates.findOneBy("linear_id", todoStateId)) {
    ls.workflowStates.insert({
      linear_id: todoStateId,
      name: "Todo",
      type: "unstarted",
      position: 1,
      color: "#e2e2e2",
      team_id: teamId,
    });
  }

  if (!ls.workflowStates.findOneBy("linear_id", "ws-2")) {
    ls.workflowStates.insert({
      linear_id: "ws-2",
      name: "In Progress",
      type: "started",
      position: 2,
      color: "#f2c94c",
      team_id: teamId,
    });
  }

  const labelId = "label-1";
  if (!ls.labels.findOneBy("linear_id", labelId)) {
    ls.labels.insert({
      linear_id: labelId,
      name: "Bug",
      color: "#eb5757",
      description: "Something is not working",
      team_id: teamId,
    });
  }

  const projectId = "project-1";
  if (!ls.projects.findOneBy("linear_id", projectId)) {
    ls.projects.insert({
      linear_id: projectId,
      name: "Launch",
      description: "Launch project",
      slug_id: "launch",
      state: "started",
      team_id: teamId,
      lead_id: userId,
      target_date: null,
    });
  }

  if (!ls.issues.findOneBy("linear_id", "issue-1")) {
    ls.issues.insert({
      linear_id: "issue-1",
      identifier: "ENG-1",
      number: 1,
      title: "First issue",
      description: "Seeded Linear issue",
      priority: 0,
      estimate: null,
      url: `${baseUrl}/ENG/issue/ENG-1/first-issue`,
      team_id: teamId,
      state_id: todoStateId,
      assignee_id: userId,
      creator_id: userId,
      project_id: projectId,
      label_ids: [labelId],
    });
  }
}

export function seedFromConfig(store: Store, baseUrl: string, config: LinearSeedConfig): void {
  const ls = getLinearStore(store);

  for (const key of config.api_keys ?? []) {
    insertApiKey(store, key);
  }

  for (const org of config.organizations ?? []) {
    const linearId = org.id ?? generateLinearId();
    if (ls.organizations.findOneBy("linear_id", linearId)) continue;
    ls.organizations.insert({
      linear_id: linearId,
      name: org.name,
      url_key: org.url_key ?? slugify(org.name),
    });
  }

  for (const user of config.users ?? []) {
    const linearId = user.id ?? generateLinearId();
    if (ls.users.findOneBy("linear_id", linearId)) continue;
    const org = findOrganization(store, user.organization);
    ls.users.insert({
      linear_id: linearId,
      name: user.name,
      email: user.email,
      display_name: user.display_name ?? user.name,
      active: user.active ?? true,
      admin: user.admin ?? false,
      organization_id: org?.linear_id ?? null,
    });
  }

  for (const team of config.teams ?? []) {
    const linearId = team.id ?? generateLinearId();
    if (ls.teams.findOneBy("linear_id", linearId)) continue;
    const org = findOrganization(store, team.organization);
    if (!org) continue;
    ls.teams.insert({
      linear_id: linearId,
      name: team.name,
      key: team.key,
      description: team.description ?? null,
      organization_id: org.linear_id,
    });
  }

  for (const state of config.workflow_states ?? []) {
    const linearId = state.id ?? generateLinearId();
    if (ls.workflowStates.findOneBy("linear_id", linearId)) continue;
    const team = findTeam(store, state.team);
    if (!team) continue;
    ls.workflowStates.insert({
      linear_id: linearId,
      name: state.name,
      type: state.type ?? "unstarted",
      position: state.position ?? ls.workflowStates.findBy("team_id", team.linear_id).length + 1,
      color: state.color ?? "#e2e2e2",
      team_id: team.linear_id,
    });
  }

  for (const label of config.labels ?? []) {
    const linearId = label.id ?? generateLinearId();
    if (ls.labels.findOneBy("linear_id", linearId)) continue;
    const team = findTeam(store, label.team);
    ls.labels.insert({
      linear_id: linearId,
      name: label.name,
      color: label.color ?? "#5e6ad2",
      description: label.description ?? null,
      team_id: team?.linear_id ?? null,
    });
  }

  for (const project of config.projects ?? []) {
    const linearId = project.id ?? generateLinearId();
    if (ls.projects.findOneBy("linear_id", linearId)) continue;
    const team = findTeam(store, project.team);
    const lead = findUser(store, project.lead);
    ls.projects.insert({
      linear_id: linearId,
      name: project.name,
      description: project.description ?? null,
      slug_id: project.slug_id ?? slugify(project.name),
      state: project.state ?? "planned",
      team_id: team?.linear_id ?? null,
      lead_id: lead?.linear_id ?? null,
      target_date: project.target_date ?? null,
    });
  }

  for (const issue of config.issues ?? []) {
    const linearId = issue.id ?? generateLinearId();
    if (ls.issues.findOneBy("linear_id", linearId)) continue;
    const team = findTeam(store, issue.team);
    if (!team) continue;
    const state = findWorkflowState(store, issue.state);
    const assignee = findUser(store, issue.assignee);
    const creator = findUser(store, issue.creator);
    const project = findProject(store, issue.project);
    const number = issueNumberForTeam(store, team.linear_id, issue.number);
    const identifier = issue.identifier ?? `${team.key}-${number}`;
    ls.issues.insert({
      linear_id: linearId,
      identifier,
      number,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority ?? 0,
      estimate: issue.estimate ?? null,
      url: `${baseUrl}/${team.key}/issue/${identifier}/${slugify(issue.title)}`,
      team_id: team.linear_id,
      state_id: state?.linear_id ?? null,
      assignee_id: assignee?.linear_id ?? null,
      creator_id: creator?.linear_id ?? null,
      project_id: project?.linear_id ?? null,
      label_ids: resolveLabelIds(store, issue.labels),
    });
  }
}

export const linearPlugin: ServicePlugin = {
  name: "linear",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    graphqlRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    insertDefaults(store, baseUrl);
  },
};

export default linearPlugin;
