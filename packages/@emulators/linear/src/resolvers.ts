import type { GraphQLFieldResolver, GraphQLResolveInfo } from "graphql";
import type { Store } from "@emulators/core";
import { getLinearStore, type LinearStore } from "./store.js";
import { linearError, toConnection, type ConnectionArgs } from "./helpers.js";
import type {
  LinearIssue,
  LinearLabel,
  LinearOrganization,
  LinearProject,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
} from "./entities.js";

export interface LinearGraphQLContext {
  store: Store;
  authToken: string;
}

type LinearSource =
  | LinearIssue
  | LinearLabel
  | LinearOrganization
  | LinearProject
  | LinearTeam
  | LinearUser
  | LinearWorkflowState
  | Record<string, unknown>;

function byCreatedAt<T extends { created_at: string; id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

function findByLinearId<T extends { linear_id: string }>(items: T[], id: string): T | null {
  return items.find((item) => item.linear_id === id) ?? null;
}

function list<T extends { created_at: string; id: number }>(items: T[], args: ConnectionArgs) {
  return toConnection(byCreatedAt(items), args);
}

function linearStore(context: LinearGraphQLContext): LinearStore {
  return getLinearStore(context.store);
}

function resolveQuery(fieldName: string, args: Record<string, unknown>, context: LinearGraphQLContext) {
  const ls = linearStore(context);

  switch (fieldName) {
    case "viewer":
      return ls.users.all()[0] ?? null;
    case "organization":
      return typeof args.id === "string"
        ? (ls.organizations.findOneBy("linear_id", args.id) ?? null)
        : (ls.organizations.all()[0] ?? null);
    case "organizations":
      return list(ls.organizations.all(), args);
    case "user":
      return findByLinearId(ls.users.all(), String(args.id));
    case "users":
      return list(ls.users.all(), args);
    case "team":
      return findByLinearId(ls.teams.all(), String(args.id));
    case "teams":
      return list(ls.teams.all(), args);
    case "workflowState":
      return findByLinearId(ls.workflowStates.all(), String(args.id));
    case "workflowStates":
      return list(ls.workflowStates.all(), args);
    case "label":
      return findByLinearId(ls.labels.all(), String(args.id));
    case "labels":
      return list(ls.labels.all(), args);
    case "project":
      return findByLinearId(ls.projects.all(), String(args.id));
    case "projects":
      return list(ls.projects.all(), args);
    case "issue":
      if (typeof args.identifier === "string") {
        return ls.issues.findOneBy("identifier", args.identifier) ?? null;
      }
      if (typeof args.id === "string") {
        return ls.issues.findOneBy("linear_id", args.id) ?? null;
      }
      throw linearError("id or identifier is required", "BAD_USER_INPUT", "validation error");
    case "issues":
      return list(ls.issues.all(), args);
    default:
      return undefined;
  }
}

function directValue(source: Record<string, unknown>, fieldName: string): unknown {
  if (fieldName in source) return source[fieldName];
  return undefined;
}

function resolveOrganization(
  source: LinearOrganization,
  fieldName: string,
  args: ConnectionArgs,
  ls: LinearStore,
): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "urlKey":
      return source.url_key;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "teams":
      return list(ls.teams.findBy("organization_id", source.linear_id), args);
    case "users":
      return list(ls.users.findBy("organization_id", source.linear_id), args);
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveUser(source: LinearUser, fieldName: string, args: ConnectionArgs, ls: LinearStore): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "displayName":
      return source.display_name;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "organization":
      return source.organization_id ? (ls.organizations.findOneBy("linear_id", source.organization_id) ?? null) : null;
    case "assignedIssues":
      return list(ls.issues.findBy("assignee_id", source.linear_id), args);
    case "createdIssues":
      return list(ls.issues.findBy("creator_id", source.linear_id), args);
    case "projectsLed":
      return list(ls.projects.findBy("lead_id", source.linear_id), args);
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveTeam(source: LinearTeam, fieldName: string, args: ConnectionArgs, ls: LinearStore): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "organization":
      return ls.organizations.findOneBy("linear_id", source.organization_id) ?? null;
    case "issues":
      return list(ls.issues.findBy("team_id", source.linear_id), args);
    case "labels":
      return list(ls.labels.findBy("team_id", source.linear_id), args);
    case "workflowStates":
      return list(ls.workflowStates.findBy("team_id", source.linear_id), args);
    case "projects":
      return list(ls.projects.findBy("team_id", source.linear_id), args);
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveWorkflowState(
  source: LinearWorkflowState,
  fieldName: string,
  args: ConnectionArgs,
  ls: LinearStore,
): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "team":
      return ls.teams.findOneBy("linear_id", source.team_id) ?? null;
    case "issues":
      return list(ls.issues.findBy("state_id", source.linear_id), args);
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveLabel(source: LinearLabel, fieldName: string, args: ConnectionArgs, ls: LinearStore): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "team":
      return source.team_id ? (ls.teams.findOneBy("linear_id", source.team_id) ?? null) : null;
    case "issues":
      return list(
        ls.issues.all().filter((issue) => issue.label_ids.includes(source.linear_id)),
        args,
      );
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveProject(source: LinearProject, fieldName: string, args: ConnectionArgs, ls: LinearStore): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "slugId":
      return source.slug_id;
    case "targetDate":
      return source.target_date;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "team":
      return source.team_id ? (ls.teams.findOneBy("linear_id", source.team_id) ?? null) : null;
    case "lead":
      return source.lead_id ? (ls.users.findOneBy("linear_id", source.lead_id) ?? null) : null;
    case "issues":
      return list(ls.issues.findBy("project_id", source.linear_id), args);
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveIssue(source: LinearIssue, fieldName: string, args: ConnectionArgs, ls: LinearStore): unknown {
  switch (fieldName) {
    case "id":
      return source.linear_id;
    case "createdAt":
      return source.created_at;
    case "updatedAt":
      return source.updated_at;
    case "team":
      return ls.teams.findOneBy("linear_id", source.team_id) ?? null;
    case "state":
      return source.state_id ? (ls.workflowStates.findOneBy("linear_id", source.state_id) ?? null) : null;
    case "assignee":
      return source.assignee_id ? (ls.users.findOneBy("linear_id", source.assignee_id) ?? null) : null;
    case "creator":
      return source.creator_id ? (ls.users.findOneBy("linear_id", source.creator_id) ?? null) : null;
    case "project":
      return source.project_id ? (ls.projects.findOneBy("linear_id", source.project_id) ?? null) : null;
    case "labels":
      return list(
        source.label_ids
          .map((id) => ls.labels.findOneBy("linear_id", id))
          .filter((label): label is LinearLabel => Boolean(label)),
        args,
      );
    default:
      return directValue(source as unknown as Record<string, unknown>, fieldName);
  }
}

function resolveObject(
  source: LinearSource,
  args: ConnectionArgs,
  context: LinearGraphQLContext,
  info: GraphQLResolveInfo,
): unknown {
  const ls = linearStore(context);

  switch (info.parentType.name) {
    case "Organization":
      return resolveOrganization(source as LinearOrganization, info.fieldName, args, ls);
    case "User":
      return resolveUser(source as LinearUser, info.fieldName, args, ls);
    case "Team":
      return resolveTeam(source as LinearTeam, info.fieldName, args, ls);
    case "WorkflowState":
      return resolveWorkflowState(source as LinearWorkflowState, info.fieldName, args, ls);
    case "Label":
      return resolveLabel(source as LinearLabel, info.fieldName, args, ls);
    case "Project":
      return resolveProject(source as LinearProject, info.fieldName, args, ls);
    case "Issue":
      return resolveIssue(source as LinearIssue, info.fieldName, args, ls);
    default:
      return directValue(source as Record<string, unknown>, info.fieldName);
  }
}

export const linearFieldResolver: GraphQLFieldResolver<LinearSource | undefined, LinearGraphQLContext> = (
  source,
  args,
  context,
  info,
) => {
  if (info.parentType.name === "Query") {
    return resolveQuery(info.fieldName, args, context);
  }

  if (!source) return undefined;
  return resolveObject(source, args, context, info);
};
