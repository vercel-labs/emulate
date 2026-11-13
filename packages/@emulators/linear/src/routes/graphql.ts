import { randomBytes } from "node:crypto";
import { buildSchema, graphql } from "graphql";
import type { Context, RouteContext, Store } from "@emulators/core";
import { getLinearStore } from "../store.js";
import { linearId } from "../ids.js";
import { connectionFromArray, type ConnectionArgs } from "../pagination.js";
import { currentUser, requireLinearScopes } from "../auth.js";
import {
  nextIssueNumber,
  resolveCycle,
  resolveIssue,
  resolveLabel,
  resolveProject,
  resolveState,
  resolveTeam,
  resolveUser,
} from "../index.js";
import type {
  LinearAgentActivity,
  LinearAgentSession,
  LinearComment,
  LinearCycle,
  LinearIssue,
  LinearIssueLabel,
  LinearIssuePriority,
  LinearProject,
  LinearTeam,
  LinearUser,
  LinearWebhook,
  LinearWorkflowState,
} from "../entities.js";
import { workflowStateColor } from "../states.js";
import {
  activityBody,
  activityContentForGraphQL,
  agentActivityWebhookPayload,
  agentSessionPromptContext,
  agentSessionWebhookPayload,
  applyExternalLinks,
  legacyActivityContent,
  legacySessionState,
  legacyStateChanges,
  oauthClientIdForAgent,
  parseActivityContent,
  parseActivityId,
  parseEphemeral,
  parsePlan,
  parseSignal,
  parseSummary,
  sessionChangesForActivity,
  userUrl,
} from "../agents.js";
import { dispatchLinearWebhook } from "../webhooks.js";

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

const schema = buildSchema(`
  scalar TeamFilter
  scalar PaginationOrderBy
  scalar JSON
  scalar JSONObject

  type Query {
    viewer: User!
    organization: Organization!
    users(first: Int, after: String, last: Int, before: String, filter: UserFilter): UserConnection!
    user(id: String!): User
    teams(
      first: Int
      after: String
      last: Int
      before: String
      filter: TeamFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): TeamConnection!
    team(id: String!): Team
    workflowStates(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    workflowState(id: String!): WorkflowState
    issues(first: Int, after: String, last: Int, before: String, filter: IssueFilter, orderBy: String): IssueConnection!
    issue(id: String!): Issue
    comments(first: Int, after: String, last: Int, before: String): CommentConnection!
    comment(id: String!): Comment
    issueLabels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    issueLabel(id: String!): IssueLabel
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
    project(id: String!): Project
    cycles(first: Int, after: String, last: Int, before: String): CycleConnection!
    cycle(id: String!): Cycle
    webhooks(first: Int, after: String, last: Int, before: String): WebhookConnection!
    webhook(id: String!): Webhook
    agentSessions(
      first: Int
      after: String
      last: Int
      before: String
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): AgentSessionConnection!
    agentSession(id: String!): AgentSession
    agentActivities(
      first: Int
      after: String
      last: Int
      before: String
      filter: AgentActivityFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): AgentActivityConnection!
    agentActivity(id: String!): AgentActivity
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: String, input: IssueUpdateInput!): IssuePayload!
    issueDelete(id: String!, permanentlyDelete: Boolean): IssueArchivePayload!
    issueArchive(id: String!, trash: Boolean): IssueArchivePayload!
    issueUnarchive(id: String!): IssueArchivePayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    commentUpdate(id: String, input: CommentUpdateInput!, skipEditedAt: Boolean): CommentPayload!
    commentDelete(id: String!): DeletePayload!
    issueLabelCreate(input: IssueLabelCreateInput!, replaceTeamLabels: Boolean): IssueLabelPayload!
    issueLabelUpdate(id: String, input: IssueLabelUpdateInput!, replaceTeamLabels: Boolean): IssueLabelPayload!
    issueLabelDelete(id: String!): DeletePayload!
    issueAddLabel(id: String!, labelId: String!): IssuePayload!
    issueRemoveLabel(id: String!, labelId: String!): IssuePayload!
    webhookCreate(input: WebhookCreateInput!): WebhookPayload!
    webhookDelete(id: String!): DeletePayload!
    agentSessionCreateOnIssue(input: AgentSessionCreateOnIssue!): AgentSessionPayload!
    agentSessionCreateOnComment(input: AgentSessionCreateOnComment!): AgentSessionPayload!
    agentSessionUpdate(id: String, input: AgentSessionUpdateInput!): AgentSessionPayload!
    agentSessionUpdateExternalUrl(id: String!, input: AgentSessionUpdateExternalUrlInput!): AgentSessionPayload!
    agentActivityCreate(input: AgentActivityCreateInput!): AgentActivityPayload!
  }

  type Organization {
    id: String!
    name: String!
    urlKey: String!
    url: String!
    createdAt: String!
    updatedAt: String!
    users(first: Int, after: String, last: Int, before: String): UserConnection!
    teams(
      first: Int
      after: String
      last: Int
      before: String
      filter: TeamFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): TeamConnection!
  }

  type User {
    id: String!
    name: String!
    displayName: String!
    email: String!
    description: String
    avatarUrl: String
    createdIssueCount: Int!
    avatarBackgroundColor: String
    statusUntilAt: String
    statusEmoji: String
    initials: String!
    lastSeen: String
    timezone: String
    disableReason: String
    statusLabel: String
    archivedAt: String
    gitHubUserId: String
    title: String
    url: String!
    active: Boolean!
    isAssignable: Boolean!
    guest: Boolean!
    admin: Boolean!
    owner: Boolean!
    app: Boolean!
    isMentionable: Boolean!
    isMe: Boolean!
    supportsAgentSessions: Boolean!
    canAccessAnyPublicTeam: Boolean!
    calendarHash: String
    inviteHash: String
    createdAt: String!
    updatedAt: String!
    assignedIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
    createdIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Team {
    id: String!
    key: String!
    name: String!
    description: String
    private: Boolean!
    url: String!
    createdAt: String!
    updatedAt: String!
    cycleIssueAutoAssignCompleted: Boolean
    cycleLockToActive: Boolean
    cycleIssueAutoAssignStarted: Boolean
    cycleCalenderUrl: String
    upcomingCycleCount: Int
    autoArchivePeriod: Int
    autoClosePeriod: Int
    securitySettings: String
    integrationsSettings: NodeRef
    activeCycle: Cycle
    triageResponsibility: NodeRef
    scimGroupName: String
    autoCloseStateId: String
    cycleCooldownTime: Int
    cycleStartDay: Int
    defaultTemplateForMembers: NodeRef
    defaultTemplateForNonMembers: NodeRef
    defaultProjectTemplate: NodeRef
    defaultIssueState: WorkflowState
    cycleDuration: Int
    icon: String
    defaultTemplateForMembersId: String
    defaultTemplateForNonMembersId: String
    issueEstimationType: String
    displayName: String
    color: String
    parent: Team
    archivedAt: String
    retiredAt: String
    timezone: String
    issueCount: Int
    visibility: String
    mergeWorkflowState: WorkflowState
    draftWorkflowState: WorkflowState
    startWorkflowState: WorkflowState
    mergeableWorkflowState: WorkflowState
    reviewWorkflowState: WorkflowState
    markedAsDuplicateWorkflowState: WorkflowState
    triageIssueState: WorkflowState
    defaultIssueEstimate: Int
    setIssueSortOrderOnStateChange: Boolean
    allMembersCanJoin: Boolean
    requirePriorityToLeaveTriage: Boolean
    autoCloseChildIssues: Boolean
    autoCloseParentIssues: Boolean
    scimManaged: Boolean
    inheritIssueEstimation: Boolean
    inheritWorkflowStatuses: Boolean
    cyclesEnabled: Boolean
    issueEstimationExtended: Boolean
    issueEstimationAllowZero: Boolean
    aiDiscussionSummariesEnabled: Boolean
    aiThreadSummariesEnabled: Boolean
    groupIssueHistory: Boolean
    slackIssueComments: Boolean
    slackNewIssue: Boolean
    slackIssueStatuses: Boolean
    triageEnabled: Boolean
    inviteHash: String
    issueOrderingNoPriorityFirst: Boolean
    issueSortOrderDefaultToBottom: Boolean
    states(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    issues(first: Int, after: String, last: Int, before: String, filter: IssueFilter): IssueConnection!
    labels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
    cycles(first: Int, after: String, last: Int, before: String): CycleConnection!
    webhooks(first: Int, after: String, last: Int, before: String): WebhookConnection!
  }

  type WorkflowState {
    id: String!
    name: String!
    type: String!
    color: String!
    position: Int!
    createdAt: String!
    updatedAt: String!
    team: Team!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Issue {
    id: String!
    identifier: String!
    number: Int!
    title: String!
    description: String
    priority: Int!
    priorityLabel: String!
    url: String!
    createdAt: String!
    updatedAt: String!
    archivedAt: String
    canceledAt: String
    completedAt: String
    startedAt: String
    dueDate: String
    createAsUser: String
    displayIconUrl: String
    team: Team!
    state: WorkflowState!
    assignee: User
    creator: User
    delegate: User
    labels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    comments(first: Int, after: String, last: Int, before: String): CommentConnection!
    project: Project
    cycle: Cycle
  }

  type Comment {
    id: String!
    body: String!
    createdAt: String!
    updatedAt: String!
    createAsUser: String
    displayIconUrl: String
    issue: Issue!
    user: User
  }

  type IssueLabel {
    id: String!
    name: String!
    color: String!
    description: String
    createdAt: String!
    updatedAt: String!
    team: Team
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Project {
    id: String!
    name: String!
    description: String
    state: String!
    createdAt: String!
    updatedAt: String!
    team: Team
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Cycle {
    id: String!
    name: String!
    number: Int!
    startsAt: String
    endsAt: String
    createdAt: String!
    updatedAt: String!
    team: Team!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Webhook {
    id: String!
    label: String!
    url: String!
    enabled: Boolean!
    resourceTypes: [String!]!
    allPublicTeams: Boolean!
    secret: String
    createdAt: String!
    updatedAt: String!
    team: Team
  }

  enum AgentSessionStatus {
    active
    awaitingInput
    complete
    error
    pending
    stale
    stopping
  }

  enum AgentSessionType {
    commentThread
  }

  enum AgentActivityType {
    action
    elicitation
    error
    prompt
    response
    thought
  }

  enum AgentActivitySignal {
    auth
    continue
    select
    stop
  }

  type AgentSessionExternalLink {
    label: String!
    url: String!
  }

  type AgentSession {
    id: String!
    status: AgentSessionStatus!
    plan: JSON
    summary: String
    externalLink: String
    externalLinks: [AgentSessionExternalLink!]!
    externalUrls: JSON!
    context: JSON!
    sourceMetadata: JSON
    slugId: String!
    url: String
    type: AgentSessionType
    appUser: User!
    creator: User
    issue: Issue
    comment: Comment
    sourceComment: Comment
    dismissedAt: String
    dismissedBy: User
    startedAt: String
    endedAt: String
    archivedAt: String
    createdAt: String!
    updatedAt: String!
    activities(
      first: Int
      after: String
      last: Int
      before: String
      filter: AgentActivityFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): AgentActivityConnection!
    "Emulator-only: the earlier emulator session state (pending, active, completed, failed, or canceled)."
    state: String!
    "Emulator-only: alias of externalLink."
    externalUrl: String
    "Emulator-only: alias of appUser."
    agentUser: User!
  }

  type AgentActivityThoughtContent {
    type: AgentActivityType!
    body: String!
  }

  type AgentActivityElicitationContent {
    type: AgentActivityType!
    body: String!
  }

  type AgentActivityResponseContent {
    type: AgentActivityType!
    body: String!
  }

  type AgentActivityErrorContent {
    type: AgentActivityType!
    body: String!
    reasonCode: String
  }

  type AgentActivityPromptContent {
    type: AgentActivityType!
    body: String!
    title: String
  }

  type AgentActivityActionContent {
    type: AgentActivityType!
    action: String!
    parameter: String!
    result: String
  }

  union AgentActivityContent =
    | AgentActivityActionContent
    | AgentActivityElicitationContent
    | AgentActivityErrorContent
    | AgentActivityPromptContent
    | AgentActivityResponseContent
    | AgentActivityThoughtContent

  type AgentActivity {
    id: String!
    agentSession: AgentSession!
    content: AgentActivityContent!
    ephemeral: Boolean!
    signal: AgentActivitySignal
    signalMetadata: JSON
    sourceMetadata: JSON
    sourceComment: Comment
    user: User!
    promptAuthor: User
    archivedAt: String
    createdAt: String!
    updatedAt: String!
    "Emulator-only: content.type."
    type: String!
    "Emulator-only: content.body, or content.action for actions."
    body: String!
    "Emulator-only: alias of agentSession."
    session: AgentSession!
  }

  type NodeRef {
    id: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type UserEdge { node: User! cursor: String! }
  type TeamEdge { node: Team! cursor: String! }
  type WorkflowStateEdge { node: WorkflowState! cursor: String! }
  type IssueEdge { node: Issue! cursor: String! }
  type CommentEdge { node: Comment! cursor: String! }
  type IssueLabelEdge { node: IssueLabel! cursor: String! }
  type ProjectEdge { node: Project! cursor: String! }
  type CycleEdge { node: Cycle! cursor: String! }
  type WebhookEdge { node: Webhook! cursor: String! }
  type AgentSessionEdge { node: AgentSession! cursor: String! }
  type AgentActivityEdge { node: AgentActivity! cursor: String! }

  type UserConnection { nodes: [User!]! edges: [UserEdge!]! pageInfo: PageInfo! }
  type TeamConnection { nodes: [Team!]! edges: [TeamEdge!]! pageInfo: PageInfo! }
  type WorkflowStateConnection { nodes: [WorkflowState!]! edges: [WorkflowStateEdge!]! pageInfo: PageInfo! }
  type IssueConnection { nodes: [Issue!]! edges: [IssueEdge!]! pageInfo: PageInfo! }
  type CommentConnection { nodes: [Comment!]! edges: [CommentEdge!]! pageInfo: PageInfo! }
  type IssueLabelConnection { nodes: [IssueLabel!]! edges: [IssueLabelEdge!]! pageInfo: PageInfo! }
  type ProjectConnection { nodes: [Project!]! edges: [ProjectEdge!]! pageInfo: PageInfo! }
  type CycleConnection { nodes: [Cycle!]! edges: [CycleEdge!]! pageInfo: PageInfo! }
  type WebhookConnection { nodes: [Webhook!]! edges: [WebhookEdge!]! pageInfo: PageInfo! }
  type AgentSessionConnection { nodes: [AgentSession!]! edges: [AgentSessionEdge!]! pageInfo: PageInfo! }
  type AgentActivityConnection { nodes: [AgentActivity!]! edges: [AgentActivityEdge!]! pageInfo: PageInfo! }

  type IssuePayload { success: Boolean! lastSyncId: Float issue: Issue }
  type CommentPayload { success: Boolean! lastSyncId: Float comment: Comment }
  type IssueLabelPayload { success: Boolean! lastSyncId: Float issueLabel: IssueLabel }
  type WebhookPayload { success: Boolean! lastSyncId: Float webhook: Webhook }
  type AgentSessionPayload { success: Boolean! lastSyncId: Float agentSession: AgentSession }
  type AgentActivityPayload { success: Boolean! lastSyncId: Float agentActivity: AgentActivity }
  type IssueArchivePayload { success: Boolean! lastSyncId: Float entity: Issue }
  type DeletePayload { success: Boolean! lastSyncId: Float entityId: String }

  input StringComparator {
    eq: String
    neq: String
    in: [String!]
    nin: [String!]
    contains: String
    startsWith: String
    endsWith: String
    eqIgnoreCase: String
    neqIgnoreCase: String
    null: Boolean
  }

  input IssueFilter {
    id: StringComparator
    identifier: StringComparator
    title: StringComparator
    team: StringComparator
    state: StringComparator
    assignee: StringComparator
    creator: StringComparator
    project: StringComparator
    cycle: StringComparator
    labels: StringComparator
    or: [IssueFilter!]
  }

  input UserFilter {
    id: StringComparator
    email: StringComparator
    name: StringComparator
    active: Boolean
    admin: Boolean
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    priority: Int
    stateId: String
    assigneeId: String
    delegateId: String
    labelIds: [String!]
    projectId: String
    cycleId: String
    createAsUser: String
    displayIconUrl: String
    dueDate: String
  }

  input IssueUpdateInput {
    id: String
    title: String
    description: String
    priority: Int
    stateId: String
    assigneeId: String
    delegateId: String
    labelIds: [String!]
    projectId: String
    cycleId: String
    archivedAt: String
    dueDate: String
  }

  input CommentCreateInput {
    issueId: String!
    body: String!
    createAsUser: String
    displayIconUrl: String
  }

  input CommentUpdateInput {
    id: String
    body: String!
  }

  input IssueLabelCreateInput {
    name: String!
    color: String
    description: String
    teamId: String
  }

  input IssueLabelUpdateInput {
    id: String
    name: String
    color: String
    description: String
  }

  input WebhookCreateInput {
    url: String!
    label: String
    resourceTypes: [String!]
    teamId: String
    allPublicTeams: Boolean
    secret: String
    enabled: Boolean
  }

  input AgentSessionExternalUrlInput {
    label: String!
    url: String!
  }

  input AgentSessionCreateOnIssue {
    issueId: String!
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
    "Emulator-only: the app user that owns the session when a human token creates it."
    agentUserId: String
    "Emulator-only: an initial free-form plan."
    plan: JSON
    "Emulator-only: alias of externalLink."
    externalUrl: String
  }

  input AgentSessionCreateOnComment {
    commentId: String!
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
    "Emulator-only: the app user that owns the session when a human token creates it."
    agentUserId: String
    "Emulator-only: an initial free-form plan."
    plan: JSON
    "Emulator-only: alias of externalLink."
    externalUrl: String
  }

  input AgentSessionUpdateInput {
    addedExternalUrls: [AgentSessionExternalUrlInput!]
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
    plan: JSONObject
    removedExternalUrls: [String!]
    summary: String
    "Emulator-only: the session ID, when the id argument is omitted."
    id: String
    "Emulator-only: sets the earlier emulator state (pending, active, completed, failed, or canceled)."
    state: String
    "Emulator-only: alias of externalLink."
    externalUrl: String
  }

  input AgentSessionUpdateExternalUrlInput {
    addedExternalUrls: [AgentSessionExternalUrlInput!]
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
    removedExternalUrls: [String!]
  }

  input AgentActivityCreateInput {
    agentSessionId: String
    content: JSONObject
    contextualMetadata: JSONObject
    ephemeral: Boolean
    id: String
    signal: AgentActivitySignal
    signalMetadata: JSONObject
    "Emulator-only flat input: the session ID."
    sessionId: String
    "Emulator-only flat input: the activity type."
    type: String
    "Emulator-only flat input: the activity body."
    body: String
  }

  input AgentActivityFilter {
    agentSessionId: StringComparator
    id: StringComparator
    type: StringComparator
    and: [AgentActivityFilter!]
    or: [AgentActivityFilter!]
  }
`);

interface LinearGraphQLContext {
  store: Store;
  c: Context;
  baseUrl: string;
}

export function graphqlRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;

  app.get("/graphql", async (c) => {
    const result = await runGraphQL(c.req.query("query") ?? "", {
      variables: parseVariables(c.req.query("variables")),
      operationName: c.req.query("operationName") ?? undefined,
      context: { store, c, baseUrl },
    });
    return c.json(result, result.errors ? 400 : 200);
  });

  app.post("/graphql", async (c) => {
    const body = await readGraphQLBody(c);
    const result = await runGraphQL(body.query, {
      variables: body.variables,
      operationName: body.operationName,
      context: { store, c, baseUrl },
    });
    return c.json(result, result.errors ? 400 : 200);
  });
}

async function runGraphQL(
  query: string,
  opts: { variables?: Record<string, unknown>; operationName?: string; context: LinearGraphQLContext },
) {
  if (!query) {
    return { errors: [{ message: "GraphQL query is required" }] };
  }

  return graphql({
    schema,
    source: query,
    rootValue: createRoot(opts.context),
    contextValue: opts.context,
    variableValues: opts.variables,
    operationName: opts.operationName,
  });
}

async function readGraphQLBody(c: Context): Promise<{
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await c.req.parseBody();
    return {
      query: bodyStr(body.query),
      variables: parseVariables(bodyStr(body.variables)),
      operationName: bodyStr(body.operationName) || undefined,
    };
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    query: typeof body.query === "string" ? body.query : "",
    variables: isRecord(body.variables) ? body.variables : undefined,
    operationName: typeof body.operationName === "string" ? body.operationName : undefined,
  };
}

function createRoot(context: LinearGraphQLContext) {
  const { store, c, baseUrl } = context;
  const ls = () => getLinearStore(store);
  const requireRead = () => requireLinearScopes(store, c, ["read"]);

  return {
    viewer: () => {
      requireRead();
      return formatUser(context, requireCurrentUser(context));
    },
    organization: () => {
      requireRead();
      return formatOrganization(context);
    },
    users: (args: ConnectionArgs & { filter?: Record<string, unknown> }) => {
      requireRead();
      return connectUsers(context, filterUsers(context, ls().users.all(), args.filter), args);
    },
    user: ({ id }: { id: string }) => {
      requireRead();
      const user = resolveUser(store, id);
      return user ? formatUser(context, user) : null;
    },
    teams: (args: ConnectionArgs & { filter?: unknown; includeArchived?: boolean; orderBy?: unknown }) => {
      requireRead();
      return connectTeams(context, filteredTeams(context, args.filter, args.includeArchived, args.orderBy), args);
    },
    team: ({ id }: { id: string }) => {
      requireRead();
      const team = resolveTeam(store, id);
      return team ? formatTeam(context, team) : null;
    },
    workflowStates: (args: ConnectionArgs) => {
      requireRead();
      return connectStates(context, sortByPosition(ls().workflowStates.all()), args);
    },
    workflowState: ({ id }: { id: string }) => {
      requireRead();
      const state = resolveState(store, id);
      return state ? formatState(context, state) : null;
    },
    issues: (args: ConnectionArgs & { filter?: Record<string, unknown>; orderBy?: string }) => {
      requireRead();
      return connectIssues(context, filteredIssues(context, args.filter, args.orderBy), args);
    },
    issue: ({ id }: { id: string }) => {
      requireRead();
      const issue = resolveIssue(store, id);
      return issue ? formatIssue(context, issue) : null;
    },
    comments: (args: ConnectionArgs) => {
      requireRead();
      return connectComments(context, sortByCreated(ls().comments.all()), args);
    },
    comment: ({ id }: { id: string }) => {
      requireRead();
      const comment = ls().comments.findOneBy("linear_id", id);
      return comment ? formatComment(context, comment) : null;
    },
    issueLabels: (args: ConnectionArgs) => {
      requireRead();
      return connectLabels(context, sortByCreated(ls().issueLabels.all()), args);
    },
    issueLabel: ({ id }: { id: string }) => {
      requireRead();
      const label = resolveLabel(store, id);
      return label ? formatLabel(context, label) : null;
    },
    projects: (args: ConnectionArgs) => {
      requireRead();
      return connectProjects(context, sortByCreated(ls().projects.all()), args);
    },
    project: ({ id }: { id: string }) => {
      requireRead();
      const project = resolveProject(store, id);
      return project ? formatProject(context, project) : null;
    },
    cycles: (args: ConnectionArgs) => {
      requireRead();
      return connectCycles(context, sortByCreated(ls().cycles.all()), args);
    },
    cycle: ({ id }: { id: string }) => {
      requireRead();
      const cycle = resolveCycle(store, id);
      return cycle ? formatCycle(context, cycle) : null;
    },
    webhooks: (args: ConnectionArgs) => {
      requireLinearScopes(store, c, ["admin"]);
      return connectWebhooks(context, sortByCreated(ls().webhooks.all()), args);
    },
    webhook: ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["admin"]);
      const webhook = ls().webhooks.findOneBy("linear_id", id);
      return webhook ? formatWebhook(context, webhook) : null;
    },
    agentSessions: (args: ConnectionArgs & { includeArchived?: boolean; orderBy?: unknown }) => {
      requireRead();
      const sessions = ls()
        .agentSessions.all()
        .filter((session) => args.includeArchived || !session.archived_at);
      return connectAgentSessions(context, sortByOrder(sessions, args.orderBy), args);
    },
    agentSession: ({ id }: { id: string }) => {
      requireRead();
      const session = ls().agentSessions.findOneBy("linear_id", id);
      return session ? formatAgentSession(context, session) : null;
    },
    agentActivities: (args: AgentActivityConnectionArgs) => {
      requireRead();
      return connectAgentActivities(context, ls().agentActivities.all(), args);
    },
    agentActivity: ({ id }: { id: string }) => {
      requireRead();
      const activity = ls().agentActivities.findOneBy("linear_id", id);
      return activity ? formatAgentActivity(context, activity) : null;
    },

    issueCreate: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["issues:create"]);
      const actor = requireCurrentUser(context);
      const team = requireTeam(store, input.teamId);
      const requestedStateId = stringInput(input.stateId);
      const state = requestedStateId
        ? resolveState(store, requestedStateId, team.linear_id)
        : (resolveState(store, "Todo", team.linear_id) ?? ls().workflowStates.findBy("team_id", team.linear_id)[0]);
      if (requestedStateId && !state) throw new Error(`Workflow state not found: ${requestedStateId}`);
      if (!state) throw new Error("No workflow state exists for the selected team");
      const labelIds = resolveIssueLabelIds(store, input.labelIds, team.linear_id);
      const title = requiredString(input.title, "title");
      const description = nullableString(input.description);
      const priority = normalizePriority(input.priority);
      const assigneeId = resolveNullableUserId(store, input.assigneeId, "assigneeId");
      const delegateId = resolveNullableUserId(store, input.delegateId, "delegateId");
      const projectId = resolveNullableProjectId(store, input.projectId, team.linear_id);
      const cycleId = resolveNullableCycleId(store, input.cycleId, team.linear_id);
      const dueDate = nullableString(input.dueDate);
      const createAsUser = nullableString(input.createAsUser);
      const displayIconUrl = nullableString(input.displayIconUrl);
      const number = nextIssueNumber(store, team.linear_id);
      const now = new Date().toISOString();
      const issue = ls().issues.insert({
        linear_id: linearId(),
        identifier: `${team.key}-${number}`,
        number,
        team_id: team.linear_id,
        title,
        description,
        priority,
        state_id: state.linear_id,
        assignee_id: assigneeId,
        creator_id: actor.linear_id,
        delegate_id: delegateId,
        project_id: projectId,
        cycle_id: cycleId,
        label_ids: labelIds,
        url: `${baseUrl}/issue/${team.key}-${number}`,
        archived_at: null,
        canceled_at: state.type === "canceled" ? now : null,
        completed_at: state.type === "completed" ? now : null,
        started_at: state.type === "started" ? now : null,
        due_date: dueDate,
        create_as_user: createAsUser,
        display_icon_url: displayIconUrl,
      });
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "create",
        data: issueWebhookPayload(context, issue),
        actor,
        teamId: issue.team_id,
        url: issue.url,
      });
      if (issue.delegate_id) {
        await createAgentSessionForIssue(context, issue, requireUser(store, issue.delegate_id), actor);
      }
      return mutationPayload({ success: true, issue: formatIssue(context, issue) });
    },

    issueUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const actor = requireCurrentUser(context);
      const issue = requireIssue(store, id ?? input.id);
      const before = issueWebhookPayload(context, issue);
      const patch: Partial<LinearIssue> = {};
      if ("title" in input) patch.title = requiredString(input.title, "title");
      if ("description" in input) patch.description = nullableString(input.description);
      if ("priority" in input) patch.priority = normalizePriority(input.priority);
      if ("stateId" in input) {
        const state = resolveState(store, stringInput(input.stateId), issue.team_id);
        if (!state) throw new Error("Workflow state not found");
        const now = new Date().toISOString();
        patch.state_id = state.linear_id;
        patch.started_at =
          state.type === "started" ? (issue.started_at ?? now) : state.type === "completed" ? issue.started_at : null;
        patch.completed_at = state.type === "completed" ? (issue.completed_at ?? now) : null;
        patch.canceled_at = state.type === "canceled" ? (issue.canceled_at ?? now) : null;
      }
      if ("assigneeId" in input) patch.assignee_id = resolveNullableUserId(store, input.assigneeId, "assigneeId");
      if ("delegateId" in input) patch.delegate_id = resolveNullableUserId(store, input.delegateId, "delegateId");
      if ("projectId" in input) patch.project_id = resolveNullableProjectId(store, input.projectId, issue.team_id);
      if ("cycleId" in input) patch.cycle_id = resolveNullableCycleId(store, input.cycleId, issue.team_id);
      if ("labelIds" in input) patch.label_ids = resolveIssueLabelIds(store, input.labelIds, issue.team_id);
      if ("archivedAt" in input) patch.archived_at = nullableString(input.archivedAt);
      if ("dueDate" in input) patch.due_date = nullableString(input.dueDate);
      const updated = ls().issues.update(issue.id, patch);
      if (!updated) throw new Error("Issue not found");
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "update",
        data: issueWebhookPayload(context, updated),
        actor,
        teamId: updated.team_id,
        url: updated.url,
        previous: before,
      });
      if (updated.delegate_id && updated.delegate_id !== issue.delegate_id) {
        await createAgentSessionForIssue(context, updated, requireUser(store, updated.delegate_id), actor);
      }
      return mutationPayload({ success: true, issue: formatIssue(context, updated) });
    },

    issueDelete: async ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, id);
      const actor = requireCurrentUser(context);
      const issueComments = ls().comments.findBy("issue_id", issue.linear_id);
      const issueSessions = ls().agentSessions.findBy("issue_id", issue.linear_id);
      const issueSessionIds = new Set(issueSessions.map((session) => session.linear_id));
      for (const activity of ls().agentActivities.all()) {
        if (issueSessionIds.has(activity.session_id)) ls().agentActivities.delete(activity.id);
      }
      for (const comment of issueComments) ls().comments.delete(comment.id);
      for (const session of issueSessions) ls().agentSessions.delete(session.id);
      ls().issues.delete(issue.id);
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "remove",
        data: issueWebhookPayload(context, issue),
        actor,
        teamId: issue.team_id,
        url: issue.url,
      });
      return issueArchivePayload(context, issue);
    },

    issueArchive: async ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, id);
      const updated = ls().issues.update(issue.id, { archived_at: new Date().toISOString() })!;
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "archive",
        data: issueWebhookPayload(context, updated),
        actor: requireCurrentUser(context),
        teamId: updated.team_id,
        url: updated.url,
      });
      return issueArchivePayload(context, updated);
    },

    issueUnarchive: async ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, id);
      const updated = ls().issues.update(issue.id, { archived_at: null })!;
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "unarchive",
        data: issueWebhookPayload(context, updated),
        actor: requireCurrentUser(context),
        teamId: updated.team_id,
        url: updated.url,
      });
      return issueArchivePayload(context, updated);
    },

    commentCreate: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["comments:create"]);
      const actor = requireCurrentUser(context);
      const issue = requireIssue(store, input.issueId);
      const comment = ls().comments.insert({
        linear_id: linearId(),
        issue_id: issue.linear_id,
        user_id: actor.linear_id,
        body: requiredString(input.body, "body"),
        create_as_user: nullableString(input.createAsUser),
        display_icon_url: nullableString(input.displayIconUrl),
      });
      await dispatchLinearWebhook(store, {
        type: "Comment",
        action: "create",
        data: commentWebhookPayload(context, comment),
        actor,
        teamId: issue.team_id,
        url: issue.url,
      });
      if (mentionsAppUser(context, comment.body)) {
        const appUser = ls()
          .users.all()
          .find((user) => user.app && comment.body.includes(user.display_name));
        if (appUser) await createAgentSessionForComment(context, comment, appUser, actor);
      }
      return mutationPayload({ success: true, comment: formatComment(context, comment) });
    },

    commentUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const comment = requireComment(store, id ?? input.id);
      const before = commentWebhookPayload(context, comment);
      const updated = ls().comments.update(comment.id, { body: requiredString(input.body, "body") })!;
      const issue = requireIssue(store, updated.issue_id);
      await dispatchLinearWebhook(store, {
        type: "Comment",
        action: "update",
        data: commentWebhookPayload(context, updated),
        actor: requireCurrentUser(context),
        teamId: issue.team_id,
        url: issue.url,
        previous: before,
      });
      return mutationPayload({ success: true, comment: formatComment(context, updated) });
    },

    commentDelete: async ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const comment = requireComment(store, id);
      const issue = requireIssue(store, comment.issue_id);
      const commentSessions = ls().agentSessions.findBy("comment_id", comment.linear_id);
      const commentSessionIds = new Set(commentSessions.map((session) => session.linear_id));
      for (const activity of ls().agentActivities.all()) {
        if (commentSessionIds.has(activity.session_id)) ls().agentActivities.delete(activity.id);
      }
      for (const session of commentSessions) ls().agentSessions.delete(session.id);
      ls().comments.delete(comment.id);
      await dispatchLinearWebhook(store, {
        type: "Comment",
        action: "remove",
        data: commentWebhookPayload(context, comment),
        actor: requireCurrentUser(context),
        teamId: issue.team_id,
        url: issue.url,
      });
      return deletePayload(comment.linear_id);
    },

    issueLabelCreate: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const teamRef = stringInput(input.teamId);
      const team = teamRef ? resolveTeam(store, teamRef) : undefined;
      if (teamRef && !team) throw new Error(`Team not found: ${teamRef}`);
      const label = ls().issueLabels.insert({
        linear_id: linearId(),
        team_id: team?.linear_id ?? null,
        name: requiredString(input.name, "name"),
        color: stringInput(input.color) ?? "#64748b",
        description: nullableString(input.description),
      });
      await dispatchLinearWebhook(store, {
        type: "IssueLabel",
        action: "create",
        data: labelWebhookPayload(context, label),
        actor: requireCurrentUser(context),
        teamId: label.team_id,
      });
      return mutationPayload({ success: true, issueLabel: formatLabel(context, label) });
    },

    issueLabelUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const label = requireLabel(store, id ?? input.id);
      const before = labelWebhookPayload(context, label);
      const updated = ls().issueLabels.update(label.id, {
        name: stringInput(input.name) ?? label.name,
        color: stringInput(input.color) ?? label.color,
        description: "description" in input ? nullableString(input.description) : label.description,
      })!;
      await dispatchLinearWebhook(store, {
        type: "IssueLabel",
        action: "update",
        data: labelWebhookPayload(context, updated),
        actor: requireCurrentUser(context),
        teamId: updated.team_id,
        previous: before,
      });
      return mutationPayload({ success: true, issueLabel: formatLabel(context, updated) });
    },

    issueLabelDelete: async ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const label = requireLabel(store, id);
      for (const issue of ls().issues.all()) {
        if (issue.label_ids.includes(label.linear_id)) {
          ls().issues.update(issue.id, { label_ids: issue.label_ids.filter((labelId) => labelId !== label.linear_id) });
        }
      }
      ls().issueLabels.delete(label.id);
      await dispatchLinearWebhook(store, {
        type: "IssueLabel",
        action: "remove",
        data: labelWebhookPayload(context, label),
        actor: requireCurrentUser(context),
        teamId: label.team_id,
      });
      return deletePayload(label.linear_id);
    },

    issueAddLabel: async ({ id, labelId }: { id: string; labelId: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, id);
      const label = requireTeamLabel(store, labelId, issue.team_id);
      const before = issueWebhookPayload(context, issue);
      const actor = requireCurrentUser(context);
      const next = Array.from(new Set([...issue.label_ids, label.linear_id]));
      const updated = ls().issues.update(issue.id, { label_ids: next })!;
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "update",
        data: issueWebhookPayload(context, updated),
        actor,
        teamId: updated.team_id,
        url: updated.url,
        previous: before,
      });
      return mutationPayload({ success: true, issue: formatIssue(context, updated) });
    },

    issueRemoveLabel: async ({ id, labelId }: { id: string; labelId: string }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, id);
      const label = requireTeamLabel(store, labelId, issue.team_id);
      const before = issueWebhookPayload(context, issue);
      const actor = requireCurrentUser(context);
      const updated = ls().issues.update(issue.id, {
        label_ids: issue.label_ids.filter((existing) => existing !== label.linear_id),
      })!;
      await dispatchLinearWebhook(store, {
        type: "Issue",
        action: "update",
        data: issueWebhookPayload(context, updated),
        actor,
        teamId: updated.team_id,
        url: updated.url,
        previous: before,
      });
      return mutationPayload({ success: true, issue: formatIssue(context, updated) });
    },

    webhookCreate: ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["admin"]);
      const teamRef = stringInput(input.teamId);
      const team = teamRef ? resolveTeam(store, teamRef) : undefined;
      if (teamRef && !team) throw new Error(`Team not found: ${teamRef}`);
      const webhook = ls().webhooks.insert({
        linear_id: linearId(),
        label: stringInput(input.label) ?? "Local webhook",
        url: requiredString(input.url, "url"),
        enabled: typeof input.enabled === "boolean" ? input.enabled : true,
        resource_types: arrayInput(input.resourceTypes, ["Issue", "Comment"]),
        team_id: team?.linear_id ?? null,
        all_public_teams: typeof input.allPublicTeams === "boolean" ? input.allPublicTeams : !team,
        secret: nullableString(input.secret),
        creator_id: requireCurrentUser(context).linear_id,
      });
      return mutationPayload({ success: true, webhook: formatWebhook(context, webhook) });
    },

    webhookDelete: ({ id }: { id: string }) => {
      requireLinearScopes(store, c, ["admin"]);
      const webhook = requireWebhook(store, id);
      ls().webhooks.delete(webhook.id);
      return deletePayload(webhook.linear_id);
    },

    agentSessionCreateOnIssue: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const issue = requireIssue(store, input.issueId);
      const actor = requireCurrentUser(context);
      const agentUser = sessionAgentUser(context, actor, input.agentUserId);
      const session = await createAgentSessionForIssue(context, issue, agentUser, actor, input);
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, session) });
    },

    agentSessionCreateOnComment: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const comment = requireComment(store, input.commentId);
      const actor = requireCurrentUser(context);
      const agentUser = sessionAgentUser(context, actor, input.agentUserId);
      const session = await createAgentSessionForComment(context, comment, agentUser, actor, input);
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, session) });
    },

    agentSessionUpdate: ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const actor = requireCurrentUser(context);
      const session = requireAgentSession(store, id ?? input.id);
      requireSessionOwner(actor, session);
      const now = new Date().toISOString();
      const changes: Partial<LinearAgentSession> = {
        ...applyExternalLinks(session, linkInput(input), requireUser(store, session.agent_user_id).name),
      };
      if (input.summary !== undefined) changes.summary = parseSummary(input.summary);
      if (input.plan !== undefined) {
        const plan = parsePlan(input.plan, now);
        // Linear ignores non-null plan updates while the session is in its error state.
        if (plan === null || session.status !== "error") changes.plan = plan;
      }
      const acknowledges = Object.keys(input).some((key) => key !== "summary" && key !== "id" && key !== "state");
      if (acknowledges && (session.status === "pending" || session.status === "stale")) {
        Object.assign(changes, { status: "active", started_at: now, ended_at: null });
      }
      if (input.state !== undefined) Object.assign(changes, legacyStateChanges(input.state, actor, now));
      const updated = ls().agentSessions.update(session.id, changes)!;
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, updated) });
    },

    agentSessionUpdateExternalUrl: ({ id, input }: { id: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const session = requireAgentSession(store, id);
      requireSessionOwner(requireCurrentUser(context), session);
      const links = applyExternalLinks(session, input, requireUser(store, session.agent_user_id).name);
      const updated = ls().agentSessions.update(session.id, links)!;
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, updated) });
    },

    agentActivityCreate: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const actor = requireCurrentUser(context);
      // The emulator's earlier flat input ({ sessionId, type, body }) is accepted when content is absent.
      const legacy = input.content === undefined || input.content === null;
      const session = requireAgentSession(store, legacy ? input.sessionId : input.agentSessionId);
      const content = legacy ? legacyActivityContent(input.type, input.body) : parseActivityContent(input.content);
      if (actor.app) {
        requireSessionOwner(actor, session);
        if (content.type === "prompt") {
          throw new Error("Agents cannot create prompt activities. Linear creates them from user messages.");
        }
      }
      const { signal, signalMetadata } = parseSignal(content.type, input.signal, input.signalMetadata, actor.app);
      const ephemeral = parseEphemeral(
        content.type,
        input.ephemeral,
        legacy && (content.type === "thought" || content.type === "action"),
      );
      const linearIdInput = parseActivityId(input.id, store);
      const activity = ls().agentActivities.insert({
        linear_id: linearIdInput ?? linearId(),
        session_id: session.linear_id,
        user_id: actor.linear_id,
        content,
        ephemeral,
        signal,
        signal_metadata: signalMetadata,
        contextual_metadata: isRecord(input.contextualMetadata) ? input.contextualMetadata : null,
        archived_at: null,
      });
      const updated = ls().agentSessions.update(
        session.id,
        sessionChangesForActivity(session, content, signal, activity.created_at),
      )!;
      if (content.type === "prompt") {
        await dispatchAgentSessionEvent(context, updated, "prompted", {
          agentActivity: agentActivityWebhookPayload(store, activity),
        });
      }
      return mutationPayload({ success: true, agentActivity: formatAgentActivity(context, activity) });
    },
  };
}

function jsonString(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function mutationPayload<T extends Record<string, unknown>>(payload: T): T & { lastSyncId: number } {
  return { lastSyncId: Date.now(), ...payload };
}

function deletePayload(entityId: string) {
  return mutationPayload({ success: true, entityId });
}

function issueArchivePayload(context: LinearGraphQLContext, issue: LinearIssue) {
  return mutationPayload({ success: true, entity: formatIssue(context, issue) });
}

function formatOrganization(context: LinearGraphQLContext) {
  const org = getLinearStore(context.store).organizations.all()[0];
  if (!org) throw new Error("Linear organization has not been seeded");
  return {
    id: org.linear_id,
    name: org.name,
    urlKey: org.url_key,
    url: org.url,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
    users: (args: ConnectionArgs) =>
      connectUsers(context, sortByCreated(getLinearStore(context.store).users.all()), args),
    teams: (args: ConnectionArgs & { filter?: unknown; includeArchived?: boolean; orderBy?: unknown }) =>
      connectTeams(context, filteredTeams(context, args.filter, args.includeArchived, args.orderBy), args),
  };
}

function formatUser(context: LinearGraphQLContext, user: LinearUser) {
  return {
    id: user.linear_id,
    name: user.name,
    displayName: user.display_name,
    email: user.email,
    description: null,
    avatarUrl: user.avatar_url,
    createdIssueCount: getLinearStore(context.store).issues.count((issue) => issue.creator_id === user.linear_id),
    avatarBackgroundColor: null,
    statusUntilAt: null,
    statusEmoji: null,
    initials: initials(user.display_name || user.name),
    lastSeen: user.active ? user.updated_at : null,
    timezone: "UTC",
    disableReason: null,
    statusLabel: null,
    archivedAt: null,
    gitHubUserId: null,
    title: null,
    url: userUrl(user),
    active: user.active,
    isAssignable: user.active,
    guest: false,
    admin: user.admin,
    owner: user.admin,
    app: user.app,
    isMentionable: user.active,
    isMe: currentUser(context.store, context.c)?.linear_id === user.linear_id,
    supportsAgentSessions: user.app,
    canAccessAnyPublicTeam: true,
    calendarHash: null,
    inviteHash: null,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    assignedIssues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(getLinearStore(context.store).issues.findBy("assignee_id", user.linear_id)),
        args,
      ),
    createdIssues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(getLinearStore(context.store).issues.findBy("creator_id", user.linear_id)),
        args,
      ),
  };
}

function formatTeam(context: LinearGraphQLContext, team: LinearTeam) {
  const ls = getLinearStore(context.store);
  const teamStates = () => ls.workflowStates.findBy("team_id", team.linear_id);
  const stateByType = (type: LinearWorkflowState["type"]) => teamStates().find((state) => state.type === type);
  const formatOptionalState = (state: LinearWorkflowState | undefined) => (state ? formatState(context, state) : null);
  return {
    id: team.linear_id,
    key: team.key,
    name: team.name,
    description: team.description,
    private: team.private,
    url: team.url,
    createdAt: team.created_at,
    updatedAt: team.updated_at,
    cycleIssueAutoAssignCompleted: false,
    cycleLockToActive: false,
    cycleIssueAutoAssignStarted: false,
    cycleCalenderUrl: null,
    upcomingCycleCount: 0,
    autoArchivePeriod: null,
    autoClosePeriod: null,
    securitySettings: null,
    integrationsSettings: null,
    activeCycle: () => {
      const activeCycle = ls.cycles.findBy("team_id", team.linear_id)[0];
      return activeCycle ? formatCycle(context, activeCycle) : null;
    },
    triageResponsibility: null,
    scimGroupName: null,
    autoCloseStateId: null,
    cycleCooldownTime: 0,
    cycleStartDay: 1,
    defaultTemplateForMembers: null,
    defaultTemplateForNonMembers: null,
    defaultProjectTemplate: null,
    defaultIssueState: () => formatOptionalState(stateByType("unstarted") ?? teamStates()[0]),
    cycleDuration: 2,
    icon: null,
    defaultTemplateForMembersId: null,
    defaultTemplateForNonMembersId: null,
    issueEstimationType: "notUsed",
    displayName: team.name,
    color: "#5e6ad2",
    parent: null,
    archivedAt: null,
    retiredAt: null,
    timezone: "UTC",
    issueCount: () => ls.issues.count((issue) => issue.team_id === team.linear_id),
    visibility: team.private ? "private" : "public",
    mergeWorkflowState: () => formatOptionalState(stateByType("completed")),
    draftWorkflowState: () => formatOptionalState(stateByType("backlog")),
    startWorkflowState: () => formatOptionalState(stateByType("started")),
    mergeableWorkflowState: () => formatOptionalState(stateByType("started")),
    reviewWorkflowState: () => formatOptionalState(stateByType("started")),
    markedAsDuplicateWorkflowState: () => formatOptionalState(stateByType("canceled")),
    triageIssueState: () => formatOptionalState(stateByType("unstarted") ?? teamStates()[0]),
    defaultIssueEstimate: null,
    setIssueSortOrderOnStateChange: false,
    allMembersCanJoin: !team.private,
    requirePriorityToLeaveTriage: false,
    autoCloseChildIssues: false,
    autoCloseParentIssues: false,
    scimManaged: false,
    inheritIssueEstimation: false,
    inheritWorkflowStatuses: false,
    cyclesEnabled: true,
    issueEstimationExtended: false,
    issueEstimationAllowZero: true,
    aiDiscussionSummariesEnabled: false,
    aiThreadSummariesEnabled: false,
    groupIssueHistory: false,
    slackIssueComments: false,
    slackNewIssue: false,
    slackIssueStatuses: false,
    triageEnabled: false,
    inviteHash: null,
    issueOrderingNoPriorityFirst: false,
    issueSortOrderDefaultToBottom: false,
    states: (args: ConnectionArgs) =>
      connectStates(context, sortByPosition(ls.workflowStates.findBy("team_id", team.linear_id)), args),
    issues: (args: ConnectionArgs & { filter?: Record<string, unknown> }) =>
      connectIssues(
        context,
        filteredIssues(context, args.filter).filter((issue) => issue.team_id === team.linear_id),
        args,
      ),
    labels: (args: ConnectionArgs) =>
      connectLabels(
        context,
        sortByCreated(
          ls.issueLabels.all().filter((label) => label.team_id === team.linear_id || label.team_id === null),
        ),
        args,
      ),
    projects: (args: ConnectionArgs) =>
      connectProjects(
        context,
        sortByCreated(
          ls.projects.all().filter((project) => project.team_id === team.linear_id || project.team_id === null),
        ),
        args,
      ),
    cycles: (args: ConnectionArgs) =>
      connectCycles(context, sortByCreated(ls.cycles.findBy("team_id", team.linear_id)), args),
    webhooks: (args: ConnectionArgs) => {
      requireLinearScopes(context.store, context.c, ["admin"]);
      return connectWebhooks(
        context,
        sortByCreated(
          ls.webhooks.all().filter((webhook) => webhook.team_id === team.linear_id || webhook.all_public_teams),
        ),
        args,
      );
    },
  };
}

function formatState(context: LinearGraphQLContext, state: LinearWorkflowState) {
  return {
    id: state.linear_id,
    name: state.name,
    type: state.type,
    color: workflowStateColor(state),
    position: state.position,
    createdAt: state.created_at,
    updatedAt: state.updated_at,
    team: () => formatTeam(context, requireTeam(context.store, state.team_id)),
    issues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(getLinearStore(context.store).issues.findBy("state_id", state.linear_id)),
        args,
      ),
  };
}

function formatIssue(context: LinearGraphQLContext, issue: LinearIssue) {
  const ls = getLinearStore(context.store);
  return {
    id: issue.linear_id,
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    priorityLabel: priorityLabelFor(issue.priority),
    url: issue.url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    archivedAt: issue.archived_at,
    canceledAt: issue.canceled_at,
    completedAt: issue.completed_at,
    startedAt: issue.started_at,
    dueDate: issue.due_date,
    createAsUser: issue.create_as_user,
    displayIconUrl: issue.display_icon_url,
    team: () => formatTeam(context, requireTeam(context.store, issue.team_id)),
    state: () => formatState(context, requireState(context.store, issue.state_id)),
    assignee: () => (issue.assignee_id ? formatUser(context, requireUser(context.store, issue.assignee_id)) : null),
    creator: () => (issue.creator_id ? formatUser(context, requireUser(context.store, issue.creator_id)) : null),
    delegate: () => (issue.delegate_id ? formatUser(context, requireUser(context.store, issue.delegate_id)) : null),
    labels: (args: ConnectionArgs) =>
      connectLabels(
        context,
        issue.label_ids
          .map((labelId) => ls.issueLabels.findOneBy("linear_id", labelId))
          .filter((label): label is LinearIssueLabel => Boolean(label)),
        args,
      ),
    comments: (args: ConnectionArgs) =>
      connectComments(context, sortByCreated(ls.comments.findBy("issue_id", issue.linear_id)), args),
    project: () => (issue.project_id ? formatProject(context, requireProject(context.store, issue.project_id)) : null),
    cycle: () => (issue.cycle_id ? formatCycle(context, requireCycle(context.store, issue.cycle_id)) : null),
  };
}

function formatComment(context: LinearGraphQLContext, comment: LinearComment) {
  return {
    id: comment.linear_id,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    createAsUser: comment.create_as_user,
    displayIconUrl: comment.display_icon_url,
    issue: () => formatIssue(context, requireIssue(context.store, comment.issue_id)),
    user: () => (comment.user_id ? formatUser(context, requireUser(context.store, comment.user_id)) : null),
  };
}

function formatLabel(context: LinearGraphQLContext, label: LinearIssueLabel) {
  return {
    id: label.linear_id,
    name: label.name,
    color: label.color,
    description: label.description,
    createdAt: label.created_at,
    updatedAt: label.updated_at,
    team: () => (label.team_id ? formatTeam(context, requireTeam(context.store, label.team_id)) : null),
    issues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(
          getLinearStore(context.store)
            .issues.all()
            .filter((issue) => issue.label_ids.includes(label.linear_id)),
        ),
        args,
      ),
  };
}

function formatProject(context: LinearGraphQLContext, project: LinearProject) {
  return {
    id: project.linear_id,
    name: project.name,
    description: project.description,
    state: project.state,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    team: () => (project.team_id ? formatTeam(context, requireTeam(context.store, project.team_id)) : null),
    issues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(getLinearStore(context.store).issues.findBy("project_id", project.linear_id)),
        args,
      ),
  };
}

function formatCycle(context: LinearGraphQLContext, cycle: LinearCycle) {
  return {
    id: cycle.linear_id,
    name: cycle.name,
    number: cycle.number,
    startsAt: cycle.starts_at,
    endsAt: cycle.ends_at,
    createdAt: cycle.created_at,
    updatedAt: cycle.updated_at,
    team: () => formatTeam(context, requireTeam(context.store, cycle.team_id)),
    issues: (args: ConnectionArgs) =>
      connectIssues(
        context,
        sortByCreated(getLinearStore(context.store).issues.findBy("cycle_id", cycle.linear_id)),
        args,
      ),
  };
}

function formatWebhook(context: LinearGraphQLContext, webhook: LinearWebhook) {
  return {
    id: webhook.linear_id,
    label: webhook.label,
    url: webhook.url,
    enabled: webhook.enabled,
    resourceTypes: webhook.resource_types,
    allPublicTeams: webhook.all_public_teams,
    secret: webhook.secret,
    createdAt: webhook.created_at,
    updatedAt: webhook.updated_at,
    team: () => (webhook.team_id ? formatTeam(context, requireTeam(context.store, webhook.team_id)) : null),
  };
}

function formatAgentSession(context: LinearGraphQLContext, session: LinearAgentSession) {
  const issue = session.issue_id ? requireIssue(context.store, session.issue_id) : null;
  const appUser = () => formatUser(context, requireUser(context.store, session.agent_user_id));
  const optionalUser = (id: string | null) => (id ? formatUser(context, requireUser(context.store, id)) : null);
  const activities = (args: AgentActivityConnectionArgs) =>
    connectAgentActivities(
      context,
      getLinearStore(context.store).agentActivities.findBy("session_id", session.linear_id),
      args,
    );
  return {
    id: session.linear_id,
    status: session.status,
    // Linear returns JSON fields as JSON-encoded strings, which @linear/sdk parses. A free-form plan from the earlier
    // emulator input is returned as it was given.
    plan: typeof session.plan === "string" ? session.plan : jsonString(session.plan),
    summary: session.summary,
    externalLink: session.external_link,
    externalLinks: session.external_links,
    externalUrls: JSON.stringify(session.external_links),
    context: "[]",
    sourceMetadata: null,
    slugId: session.slug_id,
    url: issue?.url ?? null,
    type: "commentThread",
    appUser,
    creator: () => optionalUser(session.creator_id),
    issue: () => (issue ? formatIssue(context, issue) : null),
    comment: () =>
      session.comment_id ? formatComment(context, requireComment(context.store, session.comment_id)) : null,
    sourceComment: null,
    dismissedAt: session.dismissed_at,
    dismissedBy: () => optionalUser(session.dismissed_by_id),
    startedAt: session.started_at,
    endedAt: session.ended_at,
    archivedAt: session.archived_at,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    activities,
    state: legacySessionState(session),
    externalUrl: session.external_link,
    agentUser: appUser,
  };
}

function formatAgentActivity(context: LinearGraphQLContext, activity: LinearAgentActivity) {
  const session = () => formatAgentSession(context, requireAgentSession(context.store, activity.session_id));
  const user = () => formatUser(context, requireUser(context.store, activity.user_id));
  return {
    id: activity.linear_id,
    agentSession: session,
    content: activityContentForGraphQL(activity.content),
    ephemeral: activity.ephemeral,
    signal: activity.signal,
    signalMetadata: jsonString(activity.signal_metadata),
    sourceMetadata: null,
    sourceComment: null,
    user,
    promptAuthor: () => (activity.content.type === "prompt" ? user() : null),
    archivedAt: activity.archived_at,
    createdAt: activity.created_at,
    updatedAt: activity.updated_at,
    type: activity.content.type,
    body: activityBody(activity.content),
    session,
  };
}

function connectUsers(context: LinearGraphQLContext, items: LinearUser[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatUser(context, item));
}

function connectTeams(context: LinearGraphQLContext, items: LinearTeam[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatTeam(context, item));
}

function connectStates(context: LinearGraphQLContext, items: LinearWorkflowState[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatState(context, item));
}

function connectIssues(context: LinearGraphQLContext, items: LinearIssue[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatIssue(context, item));
}

function connectComments(context: LinearGraphQLContext, items: LinearComment[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatComment(context, item));
}

function connectLabels(context: LinearGraphQLContext, items: LinearIssueLabel[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatLabel(context, item));
}

function connectProjects(context: LinearGraphQLContext, items: LinearProject[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatProject(context, item));
}

function connectCycles(context: LinearGraphQLContext, items: LinearCycle[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatCycle(context, item));
}

function connectWebhooks(context: LinearGraphQLContext, items: LinearWebhook[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatWebhook(context, item));
}

function connectAgentSessions(context: LinearGraphQLContext, items: LinearAgentSession[], args: ConnectionArgs) {
  return mapConnection(items, args, (item) => formatAgentSession(context, item));
}

interface AgentActivityConnectionArgs extends ConnectionArgs {
  filter?: Record<string, unknown>;
  includeArchived?: boolean;
  orderBy?: unknown;
}

function connectAgentActivities(
  context: LinearGraphQLContext,
  items: LinearAgentActivity[],
  args: AgentActivityConnectionArgs,
) {
  const matching = items.filter(
    (activity) => (args.includeArchived || !activity.archived_at) && activityMatchesFilter(activity, args.filter),
  );
  return mapConnection(sortByOrder(matching, args.orderBy), args, (item) => formatAgentActivity(context, item));
}

function activityMatchesFilter(activity: LinearAgentActivity, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  if (!comparatorMatches(activity.session_id, filter.agentSessionId)) return false;
  if (!comparatorMatches(activity.linear_id, filter.id)) return false;
  if (!comparatorMatches(activity.content.type, filter.type)) return false;
  if (Array.isArray(filter.and) && !filter.and.every((part) => activityMatchesFilter(activity, part))) return false;
  if (Array.isArray(filter.or) && filter.or.length > 0) {
    return filter.or.some((part) => activityMatchesFilter(activity, part));
  }
  return true;
}

function mapConnection<T, U>(items: T[], args: ConnectionArgs, mapper: (item: T) => U) {
  const mapped = connectionFromArray(items, args);
  return {
    nodes: mapped.nodes.map(mapper),
    edges: mapped.edges.map((edge) => ({ cursor: edge.cursor, node: mapper(edge.node) })),
    pageInfo: mapped.pageInfo,
  };
}

const ISSUE_FILTER_FIELDS = [
  "id",
  "identifier",
  "title",
  "team",
  "state",
  "assignee",
  "creator",
  "project",
  "cycle",
  "labels",
] as const;

function filteredIssues(
  context: LinearGraphQLContext,
  filter?: Record<string, unknown>,
  orderBy?: string,
): LinearIssue[] {
  let issues = sortByCreated(getLinearStore(context.store).issues.all());
  if (orderBy === "updatedAt") {
    issues = [...issues].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }
  if (!filter) return issues;
  return issues.filter((issue) => issueMatchesFilter(context, issue, filter));
}

function filteredTeams(
  context: LinearGraphQLContext,
  filter?: unknown,
  _includeArchived?: boolean,
  orderBy?: unknown,
): LinearTeam[] {
  let teams = sortByCreated(getLinearStore(context.store).teams.all());
  if (isRecord(orderBy)) {
    const field = typeof orderBy.field === "string" ? orderBy.field : Object.keys(orderBy)[0];
    const direction =
      typeof orderBy.direction === "string"
        ? orderBy.direction
        : field && typeof orderBy[field] === "string"
          ? orderBy[field]
          : undefined;
    const multiplier = direction?.toLowerCase().startsWith("desc") ? -1 : 1;
    if (field === "key" || field === "name" || field === "createdAt" || field === "updatedAt") {
      teams = [...teams].sort((a, b) => teamOrderValue(a, field).localeCompare(teamOrderValue(b, field)) * multiplier);
    }
  }
  if (!isRecord(filter)) return teams;
  return teams.filter((team) => teamMatchesFilter(team, filter));
}

function teamOrderValue(team: LinearTeam, field: string): string {
  if (field === "key") return team.key;
  if (field === "name") return team.name;
  if (field === "updatedAt") return team.updated_at;
  return team.created_at;
}

function teamMatchesFilter(team: LinearTeam, filter: Record<string, unknown>): boolean {
  const checks = [
    aliasComparatorMatches([team.linear_id, team.key, team.name], filter.id),
    comparatorMatches(team.key, filter.key),
    comparatorMatches(team.name, filter.name),
    comparatorMatches(team.name, filter.displayName),
    typeof filter.private !== "boolean" || team.private === filter.private,
  ];
  const orFilters = Array.isArray(filter.or) ? filter.or.filter(isRecord) : [];
  const hasOwnPredicate = ["id", "key", "name", "displayName", "private"].some((field) => filter[field] != null);
  const ownMatch = hasOwnPredicate ? checks.every(Boolean) : orFilters.length === 0;
  return ownMatch || orFilters.some((orFilter) => teamMatchesFilter(team, orFilter));
}

function issueMatchesFilter(
  context: LinearGraphQLContext,
  issue: LinearIssue,
  filter: Record<string, unknown>,
): boolean {
  const ls = getLinearStore(context.store);
  const team = ls.teams.findOneBy("linear_id", issue.team_id);
  const state = ls.workflowStates.findOneBy("linear_id", issue.state_id);
  const assignee = issue.assignee_id ? ls.users.findOneBy("linear_id", issue.assignee_id) : undefined;
  const creator = issue.creator_id ? ls.users.findOneBy("linear_id", issue.creator_id) : undefined;
  const project = issue.project_id ? ls.projects.findOneBy("linear_id", issue.project_id) : undefined;
  const cycle = issue.cycle_id ? ls.cycles.findOneBy("linear_id", issue.cycle_id) : undefined;
  const labels = issue.label_ids
    .map((labelId) => ls.issueLabels.findOneBy("linear_id", labelId))
    .filter((label): label is LinearIssueLabel => Boolean(label));

  const checks = [
    comparatorMatches(issue.linear_id, filter.id),
    comparatorMatches(issue.identifier, filter.identifier),
    comparatorMatches(issue.title, filter.title),
    aliasComparatorMatches([team?.linear_id, team?.key, team?.name], filter.team),
    aliasComparatorMatches([state?.linear_id, state?.name, state?.type], filter.state),
    aliasComparatorMatches([assignee?.linear_id, assignee?.email, assignee?.name], filter.assignee),
    aliasComparatorMatches([creator?.linear_id, creator?.email, creator?.name], filter.creator),
    aliasComparatorMatches([project?.linear_id, project?.name], filter.project),
    aliasComparatorMatches([cycle?.linear_id, cycle?.name], filter.cycle),
    aliasComparatorMatches(
      labels.flatMap((label) => [label.linear_id, label.name]),
      filter.labels,
    ),
  ];
  const orFilters = Array.isArray(filter.or) ? filter.or.filter(isRecord) : [];
  const ownMatch = issueFilterHasOwnPredicates(filter) ? checks.every(Boolean) : orFilters.length === 0;
  return ownMatch || orFilters.some((orFilter) => issueMatchesFilter(context, issue, orFilter));
}

function issueFilterHasOwnPredicates(filter: Record<string, unknown>): boolean {
  return ISSUE_FILTER_FIELDS.some((field) => filter[field] != null);
}

function filterUsers(
  context: LinearGraphQLContext,
  users: LinearUser[],
  filter?: Record<string, unknown>,
): LinearUser[] {
  if (!filter) return sortByCreated(users);
  return sortByCreated(users).filter(
    (user) =>
      comparatorMatches(user.linear_id, filter.id) &&
      comparatorMatches(user.email, filter.email) &&
      comparatorMatches(user.name, filter.name) &&
      (typeof filter.active !== "boolean" || user.active === filter.active) &&
      (typeof filter.admin !== "boolean" || user.admin === filter.admin),
  );
}

function comparatorMatches(value: string | undefined | null, input: unknown): boolean {
  if (!input || !isRecord(input)) return true;
  if ("null" in input && typeof input.null === "boolean") return input.null ? value == null : value != null;
  if (value == null) return false;
  const val = String(value);
  if (typeof input.eq === "string" && val !== input.eq) return false;
  if (typeof input.neq === "string" && val === input.neq) return false;
  if (Array.isArray(input.in) && !input.in.includes(val)) return false;
  if (Array.isArray(input.nin) && input.nin.includes(val)) return false;
  if (typeof input.contains === "string" && !val.includes(input.contains)) return false;
  if (typeof input.startsWith === "string" && !val.startsWith(input.startsWith)) return false;
  if (typeof input.endsWith === "string" && !val.endsWith(input.endsWith)) return false;
  if (typeof input.eqIgnoreCase === "string" && val.toLowerCase() !== input.eqIgnoreCase.toLowerCase()) return false;
  if (typeof input.neqIgnoreCase === "string" && val.toLowerCase() === input.neqIgnoreCase.toLowerCase()) return false;
  return true;
}

function aliasComparatorMatches(values: Array<string | undefined | null>, input: unknown): boolean {
  if (!input || !isRecord(input)) return true;
  const candidates = values.filter((value): value is string => value != null);
  if ("null" in input && typeof input.null === "boolean") {
    return input.null ? candidates.length === 0 : candidates.length > 0;
  }
  if (candidates.length === 0) return false;

  const neq = typeof input.neq === "string" ? input.neq : undefined;
  const nin = Array.isArray(input.nin) ? input.nin : undefined;
  const neqIgnoreCase = typeof input.neqIgnoreCase === "string" ? input.neqIgnoreCase : undefined;
  if (neq !== undefined && candidates.some((value) => value === neq)) return false;
  if (nin && candidates.some((value) => nin.includes(value))) return false;
  if (neqIgnoreCase !== undefined && candidates.some((value) => value.toLowerCase() === neqIgnoreCase.toLowerCase())) {
    return false;
  }

  if (!hasPositiveComparator(input)) return true;
  return candidates.some((value) => positiveComparatorMatches(value, input));
}

function hasPositiveComparator(input: Record<string, unknown>): boolean {
  return (
    typeof input.eq === "string" ||
    Array.isArray(input.in) ||
    typeof input.contains === "string" ||
    typeof input.startsWith === "string" ||
    typeof input.endsWith === "string" ||
    typeof input.eqIgnoreCase === "string"
  );
}

function positiveComparatorMatches(value: string, input: Record<string, unknown>): boolean {
  if (typeof input.eq === "string" && value !== input.eq) return false;
  if (Array.isArray(input.in) && !input.in.includes(value)) return false;
  if (typeof input.contains === "string" && !value.includes(input.contains)) return false;
  if (typeof input.startsWith === "string" && !value.startsWith(input.startsWith)) return false;
  if (typeof input.endsWith === "string" && !value.endsWith(input.endsWith)) return false;
  if (typeof input.eqIgnoreCase === "string" && value.toLowerCase() !== input.eqIgnoreCase.toLowerCase()) return false;
  return true;
}

function sortByCreated<T extends { created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// PaginationOrderBy: createdAt (the default) or updatedAt.
function sortByOrder<T extends { created_at: string; updated_at: string }>(items: T[], orderBy: unknown): T[] {
  const field = orderBy === "updatedAt" ? "updated_at" : "created_at";
  return [...items].sort((a, b) => a[field].localeCompare(b[field]));
}

function sortByPosition<T extends { position: number; created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

function requireCurrentUser(context: LinearGraphQLContext): LinearUser {
  const user = currentUser(context.store, context.c);
  if (!user) throw new Error("Linear user not found");
  return user;
}

function requireUser(store: Store, id: string): LinearUser {
  const user = resolveUser(store, id);
  if (!user) throw new Error(`User not found: ${id}`);
  return user;
}

function requireTeam(store: Store, id: unknown): LinearTeam {
  const team = resolveTeam(store, requiredString(id, "teamId"));
  if (!team) throw new Error(`Team not found: ${String(id)}`);
  return team;
}

function requireState(store: Store, id: string): LinearWorkflowState {
  const state = resolveState(store, id);
  if (!state) throw new Error(`Workflow state not found: ${id}`);
  return state;
}

function requireIssue(store: Store, id: unknown): LinearIssue {
  const issue = resolveIssue(store, requiredString(id, "id"));
  if (!issue) throw new Error(`Issue not found: ${String(id)}`);
  return issue;
}

function requireComment(store: Store, id: unknown): LinearComment {
  const ref = requiredString(id, "id");
  const comment = getLinearStore(store).comments.findOneBy("linear_id", ref);
  if (!comment) throw new Error(`Comment not found: ${ref}`);
  return comment;
}

function requireLabel(store: Store, id: unknown): LinearIssueLabel {
  const label = resolveLabel(store, requiredString(id, "id"));
  if (!label) throw new Error(`Issue label not found: ${String(id)}`);
  return label;
}

function requireTeamLabel(store: Store, id: unknown, teamId: string): LinearIssueLabel {
  const ref = requiredString(id, "labelId");
  const label = resolveLabel(store, ref, teamId);
  if (!label) throw new Error(`Issue label not found for team: ${ref}`);
  return label;
}

function requireProject(store: Store, id: string): LinearProject {
  const project = resolveProject(store, id);
  if (!project) throw new Error(`Project not found: ${id}`);
  return project;
}

function requireCycle(store: Store, id: string): LinearCycle {
  const cycle = resolveCycle(store, id);
  if (!cycle) throw new Error(`Cycle not found: ${id}`);
  return cycle;
}

function requireWebhook(store: Store, id: string): LinearWebhook {
  const webhook = getLinearStore(store).webhooks.findOneBy("linear_id", id);
  if (!webhook) throw new Error(`Webhook not found: ${id}`);
  return webhook;
}

function requireAgentSession(store: Store, id: unknown): LinearAgentSession {
  const ref = requiredString(id, "id");
  const session = getLinearStore(store).agentSessions.findOneBy("linear_id", ref);
  if (!session) throw new Error(`Agent session not found: ${ref}`);
  return session;
}

function resolveNullableUserId(store: Store, value: unknown, field: string): string | null {
  const ref = stringInput(value);
  if (!ref) return null;
  const user = resolveUser(store, ref);
  if (!user) throw new Error(`User not found for ${field}: ${ref}`);
  return user.linear_id;
}

function resolveNullableProjectId(store: Store, value: unknown, teamId: string): string | null {
  const ref = stringInput(value);
  if (!ref) return null;
  const project = resolveProject(store, ref);
  if (!project || (project.team_id !== null && project.team_id !== teamId)) {
    throw new Error(`Project not found for team: ${ref}`);
  }
  return project.linear_id;
}

function resolveNullableCycleId(store: Store, value: unknown, teamId: string): string | null {
  const ref = stringInput(value);
  if (!ref) return null;
  const cycle = resolveCycle(store, ref, teamId);
  if (!cycle) throw new Error(`Cycle not found for team: ${ref}`);
  return cycle.linear_id;
}

function resolveIssueLabelIds(store: Store, value: unknown, teamId: string): string[] {
  return arrayInput(value).map((labelId) => {
    const label = resolveLabel(store, labelId, teamId);
    if (!label) throw new Error(`Issue label not found for team: ${labelId}`);
    return label.linear_id;
  });
}

/**
 * The app user that owns a new session. An agent token owns the sessions it creates. A human token may name the agent
 * with the emulator-only agentUserId input, and otherwise gets the first app user, or itself when there is none.
 */
function sessionAgentUser(context: LinearGraphQLContext, actor: LinearUser, agentUserId: unknown): LinearUser {
  if (actor.app) return actor;
  const ref = stringInput(agentUserId);
  if (ref) return requireUser(context.store, ref);
  return (
    getLinearStore(context.store)
      .users.all()
      .find((user) => user.app) ?? actor
  );
}

function requireSessionOwner(actor: LinearUser, session: LinearAgentSession): void {
  if (actor.app && session.agent_user_id !== actor.linear_id) {
    throw new Error(`Agent session ${session.linear_id} belongs to another agent`);
  }
}

function linkInput(input: Record<string, unknown>): Record<string, unknown> {
  if (input.externalLink !== undefined || input.externalUrl === undefined) return input;
  return { ...input, externalLink: nullableString(input.externalUrl) };
}

async function createAgentSessionForIssue(
  context: LinearGraphQLContext,
  issue: LinearIssue,
  agentUser: LinearUser,
  actor: LinearUser,
  input: Record<string, unknown> = {},
): Promise<LinearAgentSession> {
  const existing = getLinearStore(context.store)
    .agentSessions.findBy("issue_id", issue.linear_id)
    .find(
      (session) =>
        session.agent_user_id === agentUser.linear_id && !session.comment_id && session.status !== "complete",
    );
  if (existing) return existing;
  return createAgentSession(context, issue, null, agentUser, actor, input);
}

async function createAgentSessionForComment(
  context: LinearGraphQLContext,
  comment: LinearComment,
  agentUser: LinearUser,
  actor: LinearUser,
  input: Record<string, unknown> = {},
): Promise<LinearAgentSession> {
  const issue = requireIssue(context.store, comment.issue_id);
  return createAgentSession(context, issue, comment, agentUser, actor, input);
}

async function createAgentSession(
  context: LinearGraphQLContext,
  issue: LinearIssue,
  comment: LinearComment | null,
  agentUser: LinearUser,
  actor: LinearUser,
  input: Record<string, unknown>,
): Promise<LinearAgentSession> {
  const links = applyExternalLinks({ external_link: null, external_links: [] }, linkInput(input), agentUser.name);
  const session = getLinearStore(context.store).agentSessions.insert({
    linear_id: linearId(),
    slug_id: randomBytes(6).toString("hex"),
    issue_id: issue.linear_id,
    comment_id: comment?.linear_id ?? null,
    agent_user_id: agentUser.linear_id,
    creator_id: actor.app ? null : actor.linear_id,
    status: "pending",
    plan: input.plan === undefined || input.plan === null ? null : parsePlan(input.plan, new Date().toISOString()),
    summary: null,
    ...links,
    started_at: null,
    ended_at: null,
    dismissed_at: null,
    dismissed_by_id: null,
    archived_at: null,
  });
  await dispatchAgentSessionEvent(context, session, "created", {
    promptContext: agentSessionPromptContext(context.store, session),
  });
  return session;
}

/** Sends an AgentSessionEvent with the AgentSessionEventWebhookPayload fields. */
async function dispatchAgentSessionEvent(
  context: LinearGraphQLContext,
  session: LinearAgentSession,
  action: "created" | "prompted",
  fields: Record<string, unknown>,
): Promise<void> {
  const issue = session.issue_id ? getLinearStore(context.store).issues.findOneBy("linear_id", session.issue_id) : null;
  await dispatchLinearWebhook(context.store, {
    type: "AgentSessionEvent",
    action,
    teamId: issue?.team_id ?? null,
    fields: {
      agentSession: agentSessionWebhookPayload(context.store, session),
      ...fields,
      appUserId: session.agent_user_id,
      oauthClientId: oauthClientIdForAgent(context.store, session.agent_user_id),
    },
  });
}

function issueWebhookPayload(context: LinearGraphQLContext, issue: LinearIssue) {
  const state = getLinearStore(context.store).workflowStates.findOneBy("linear_id", issue.state_id);
  return {
    id: issue.linear_id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    teamId: issue.team_id,
    stateId: issue.state_id,
    state: state ? { id: state.linear_id, name: state.name, type: state.type, color: workflowStateColor(state) } : null,
    assigneeId: issue.assignee_id,
    delegateId: issue.delegate_id,
    projectId: issue.project_id,
    cycleId: issue.cycle_id,
    dueDate: issue.due_date,
    startedAt: issue.started_at,
    completedAt: issue.completed_at,
    canceledAt: issue.canceled_at,
    url: issue.url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    archivedAt: issue.archived_at,
    labelIds: issue.label_ids,
    labels: issue.label_ids
      .map((labelId) => getLinearStore(context.store).issueLabels.findOneBy("linear_id", labelId))
      .filter(Boolean)
      .map((label) => ({ id: label!.linear_id, name: label!.name })),
  };
}

function commentWebhookPayload(context: LinearGraphQLContext, comment: LinearComment) {
  return {
    id: comment.linear_id,
    body: comment.body,
    issueId: comment.issue_id,
    userId: comment.user_id,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function labelWebhookPayload(_context: LinearGraphQLContext, label: LinearIssueLabel) {
  return {
    id: label.linear_id,
    name: label.name,
    color: label.color,
    description: label.description,
    teamId: label.team_id,
    createdAt: label.created_at,
    updatedAt: label.updated_at,
  };
}

function mentionsAppUser(context: LinearGraphQLContext, body: string): boolean {
  return getLinearStore(context.store)
    .users.all()
    .some((user) => user.app && body.includes(user.display_name));
}

function normalizePriority(value: unknown): LinearIssuePriority {
  if (typeof value !== "number") return 0;
  if (value <= 0) return 0;
  if (value >= 4) return 4;
  return value as LinearIssuePriority;
}

function priorityLabelFor(priority: number): string {
  return PRIORITY_LABELS[Math.round(priority)] ?? PRIORITY_LABELS[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${field} is required`);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayInput(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bodyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function parseVariables(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
