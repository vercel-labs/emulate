import { buildSchema, graphql } from "graphql";
import { escapeAttr, escapeHtml, type Context, type RouteContext, type Store } from "@emulators/core";
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
  LinearAgentPlanStep,
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
import {
  activityContentAsGraphQL,
  activityContentAsJSON,
  applyExternalUrlUpdates,
  parseAgentActivityCreateInput,
  parseAgentPromptActivityCreateInput,
  parsePlanInput,
  parseSessionLinksInput,
  statusFromActivity,
  type SessionLinks,
} from "../agents.js";
import { withJSONObjectScalar } from "../json-object.js";
import {
  dispatchLinearWebhook,
  type LinearAgentActivityWebhookPayload,
  type LinearCommentWebhookPayload,
  type LinearIssueWebhookPayload,
  type LinearAgentSessionWebhookPayload,
  type LinearUserWebhookPayload,
} from "../webhooks.js";

const schema = withJSONObjectScalar(
  buildSchema(`
  scalar TeamFilter
  scalar JSONObject

  enum PaginationOrderBy { createdAt updatedAt }

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
    agentSessions(first: Int, after: String, last: Int, before: String): AgentSessionConnection!
    agentSession(id: String!): AgentSession
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
    agentSessionUpdate(id: String!, input: AgentSessionUpdateInput!): AgentSessionPayload!
    agentActivityCreate(input: AgentActivityCreateInput!): AgentActivityPayload!
    agentActivityCreatePrompt(input: AgentActivityCreatePromptInput!): AgentActivityPayload!
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
    ledInitiativeCount: Int!
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

  type AgentSessionExternalLink {
    label: String!
    url: String!
  }

  type AgentSession {
    id: String!
    status: AgentSessionStatus!
    plan: JSONObject
    externalLink: String
    externalUrls: JSONObject!
    externalLinks: [AgentSessionExternalLink!]!
    sourceMetadata: JSONObject
    context: JSONObject!
    url: String
    slugId: String!
    type: AgentSessionType
    archivedAt: String
    dismissedAt: String
    dismissedBy: User
    startedAt: String
    endedAt: String
    summary: String
    createdAt: String!
    updatedAt: String!
    issue: Issue
    sourceComment: Comment
    comment: Comment
    appUser: User!
    creator: User
    activities(
      first: Int
      after: String
      last: Int
      before: String
      filter: AgentActivityFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): AgentActivityConnection!
  }

  type AgentActivity {
    id: String!
    content: AgentActivityContent!
    contextualMetadata: JSONObject
    ephemeral: Boolean!
    pushSummary: AgentActivityPushSummary
    queued: Boolean!
    sentAt: String
    signal: AgentActivitySignal
    signalMetadata: JSONObject
    sourceMetadata: JSONObject
    sourceComment: Comment
    archivedAt: String
    createdAt: String!
    updatedAt: String!
    agentSession: AgentSession!
    user: User!
  }

  union AgentActivityContent = AgentActivityActionContent | AgentActivityElicitationContent | AgentActivityErrorContent | AgentActivityPromptContent | AgentActivityResponseContent | AgentActivityThoughtContent

  type AgentActivityActionContent {
    type: AgentActivityType!
    action: String!
    parameter: String!
    result: String
    resultData: JSONObject
  }

  type AgentActivityElicitationContent { type: AgentActivityType! body: String! bodyData: JSONObject! }
  type AgentActivityErrorContent { type: AgentActivityType! body: String! bodyData: JSONObject! reasonCode: String }
  type AgentActivityPromptContent { type: AgentActivityType! body: String! bodyData: JSONObject! title: String }
  type AgentActivityResponseContent { type: AgentActivityType! body: String! bodyData: JSONObject! }
  type AgentActivityThoughtContent { type: AgentActivityType! body: String! bodyData: JSONObject! }

  type AgentActivityPushSummary {
    additionalCommitShas: [String!]!
    baseSha: String!
    commitCount: Int!
    commits: [AgentActivityPushCommit!]!
    headSha: String!
  }

  type AgentActivityPushCommit {
    additions: Int!
    changedFiles: Int!
    deletions: Int!
    sha: String!
  }

  enum AgentActivityType { action elicitation error prompt response thought }
  enum AgentActivitySignal { auth continue select stop }
  enum AgentSessionStatus { active awaitingInput complete error pending stale }
  enum AgentSessionType { commentThread }

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
  }

  input AgentSessionCreateOnComment {
    commentId: String!
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
  }

  """
  Production Linear AgentSessionUpdateInput. Session status is driven by
  activities, not set here.
  """
  input AgentSessionUpdateInput {
    addedExternalUrls: [AgentSessionExternalUrlInput!]
    externalLink: String
    externalUrls: [AgentSessionExternalUrlInput!]
    plan: JSONObject
    removedExternalUrls: [String!]
  }

  input AgentActivityCreateInput {
    agentSessionId: String!
    content: JSONObject!
    contextualMetadata: JSONObject
    ephemeral: Boolean
    id: String
    signal: AgentActivitySignal
    signalMetadata: JSONObject
  }

  input AgentActivityPromptCreateInputContent {
    body: String
    bodyData: JSONObject
    type: AgentActivityType = prompt
  }

  input AgentActivityCreatePromptInput {
    agentSessionId: String!
    content: AgentActivityPromptCreateInputContent!
    contextualMetadata: JSONObject
    id: String
    queued: Boolean
    signal: AgentActivitySignal
    signalMetadata: JSONObject
    sourceCommentId: String
  }

  input AgentActivityFilter {
    agentSessionId: StringComparator
    and: [AgentActivityFilter!]
    id: StringComparator
    or: [AgentActivityFilter!]
    type: StringComparator
  }
`),
);

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
    agentSessions: (args: ConnectionArgs) => {
      requireRead();
      return connectAgentSessions(context, sortByCreated(ls().agentSessions.all()), args);
    },
    agentSession: ({ id }: { id: string }) => {
      requireRead();
      const session = ls().agentSessions.findOneBy("linear_id", id);
      return session ? formatAgentSession(context, session) : null;
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
        await createAgentSessionForIssue(context, issue, issue.delegate_id, actor);
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
        updatedFrom: before,
      });
      if (updated.delegate_id && updated.delegate_id !== issue.delegate_id) {
        await createAgentSessionForIssue(context, updated, updated.delegate_id, actor);
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
        if (appUser) await createAgentSessionForComment(context, comment, appUser.linear_id, actor);
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
        updatedFrom: before,
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
        updatedFrom: before,
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
        updatedFrom: before,
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
        updatedFrom: before,
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
      const actor = requireAgentAppActor(context);
      const session = await createAgentSessionForIssue(
        context,
        issue,
        actor.linear_id,
        null,
        null,
        parseSessionLinksInput(input),
      );
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, session) });
    },

    agentSessionCreateOnComment: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const comment = requireComment(store, input.commentId);
      const actor = requireAgentAppActor(context);
      const session = await createAgentSessionForComment(
        context,
        comment,
        actor.linear_id,
        null,
        null,
        parseSessionLinksInput(input),
      );
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, session) });
    },

    agentSessionUpdate: ({ id, input }: { id: string; input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const actor = requireAgentAppActor(context);
      // Production drives status from activities; update only mutates plan/links.
      const session = requireAgentSession(store, id);
      requireAgentSessionOwner(context, session, actor);
      const plan = "plan" in input ? parsePlanInput(input.plan) : session.plan;
      const links = applyExternalUrlUpdates(
        { external_link: session.external_link, external_urls: session.external_urls },
        input,
      );
      const updated = ls().agentSessions.update(session.id, {
        plan,
        external_link: links.external_link,
        external_urls: links.external_urls,
      })!;
      return mutationPayload({ success: true, agentSession: formatAgentSession(context, updated) });
    },

    agentActivityCreate: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const parsed = parseAgentActivityCreateInput(input);
      const session = requireAgentSession(store, parsed.agentSessionId);
      const actor = requireAgentAppActor(context);
      requireAgentSessionOwner(context, session, actor);
      const now = new Date().toISOString();
      const activity = ls().agentActivities.insert({
        linear_id: stringInput(input.id) ?? linearId(),
        session_id: session.linear_id,
        user_id: actor.linear_id,
        source_comment_id: null,
        content: parsed.content,
        contextual_metadata: recordInput(input.contextualMetadata),
        archived_at: null,
        ephemeral: parsed.ephemeral,
        queued: false,
        sent_at: null,
        signal: parsed.signal,
        signal_metadata: parsed.signalMetadata,
      });
      archiveEphemeralAgentActivities(context, session.linear_id, activity.linear_id, now);

      const nextStatus = statusFromActivity(parsed.content.type, parsed.signal);
      const updatedSession = ls().agentSessions.update(session.id, {
        status: nextStatus,
        started_at:
          nextStatus === "active" || nextStatus === "awaitingInput" ? (session.started_at ?? now) : session.started_at,
        ended_at:
          nextStatus === "complete" || nextStatus === "error"
            ? now
            : nextStatus === "active" || nextStatus === "awaitingInput" || nextStatus === "pending"
              ? null
              : session.ended_at,
      })!;

      if (nextStatus === "complete" || nextStatus === "error") {
        await deliverNextQueuedPrompt(context, updatedSession);
      }

      return mutationPayload({ success: true, agentActivity: formatAgentActivity(context, activity) });
    },

    agentActivityCreatePrompt: async ({ input }: { input: Record<string, unknown> }) => {
      requireLinearScopes(store, c, ["write"]);
      const parsed = parseAgentPromptActivityCreateInput(input);
      const session = requireAgentSession(store, parsed.agentSessionId);
      const actor = requireCurrentUser(context);
      if (actor.app) throw new Error("Prompt activities must be created by a human user");
      const sourceCommentId = stringInput(input.sourceCommentId);
      if (sourceCommentId) {
        const sourceComment = requireComment(store, sourceCommentId);
        if (sourceComment.issue_id !== session.issue_id) {
          throw new Error("sourceCommentId must belong to the agent session issue");
        }
      }
      const activity = ls().agentActivities.insert({
        linear_id: stringInput(input.id) ?? linearId(),
        session_id: session.linear_id,
        user_id: actor.linear_id,
        source_comment_id: sourceCommentId ?? null,
        content: parsed.content,
        contextual_metadata: recordInput(input.contextualMetadata),
        archived_at: null,
        ephemeral: false,
        queued: input.queued === true && session.status !== "complete" && session.status !== "error",
        sent_at: null,
        signal: parsed.signal,
        signal_metadata: parsed.signalMetadata,
      });
      if (activity.queued) {
        return mutationPayload({ success: true, agentActivity: formatAgentActivity(context, activity) });
      }
      const now = new Date().toISOString();
      const updatedSession = ls().agentSessions.update(session.id, {
        status: "active",
        started_at: session.started_at ?? now,
        ended_at: null,
      })!;
      await dispatchAgentSessionEvent(context, {
        action: "prompted",
        session: updatedSession,
        activity,
        actor,
      });
      return mutationPayload({ success: true, agentActivity: formatAgentActivity(context, activity) });
    },
  };
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
    url: `https://linear.app/user/${encodeURIComponent(user.email)}`,
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
    ledInitiativeCount: 0,
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
  const externalLinks = session.external_urls.map((link) => ({ label: link.label, url: link.url }));
  const appUser = () => formatUser(context, requireUser(context.store, session.agent_user_id));
  const issue = () => (session.issue_id ? formatIssue(context, requireIssue(context.store, session.issue_id)) : null);
  return {
    id: session.linear_id,
    status: session.status,
    plan: session.plan,
    externalLink: session.external_link,
    externalUrls: externalLinks,
    externalLinks,
    sourceMetadata: null,
    context: {},
    url: session.issue_id ? requireIssue(context.store, session.issue_id).url : null,
    slugId: session.linear_id,
    type: "commentThread",
    archivedAt: null,
    dismissedAt: null,
    dismissedBy: null,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    summary: session.summary,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    issue,
    sourceComment: null,
    comment: () =>
      session.comment_id ? formatComment(context, requireComment(context.store, session.comment_id)) : null,
    appUser,
    creator: () => (session.creator_id ? formatUser(context, requireUser(context.store, session.creator_id)) : null),
    activities: (args: AgentActivityConnectionArgs) =>
      connectAgentActivities(
        context,
        getLinearStore(context.store).agentActivities.findBy("session_id", session.linear_id),
        args,
      ),
  };
}

function formatAgentActivity(context: LinearGraphQLContext, activity: LinearAgentActivity) {
  const agentSession = () => formatAgentSession(context, requireAgentSession(context.store, activity.session_id));
  return {
    id: activity.linear_id,
    content: activityContentAsGraphQL(activity.content),
    contextualMetadata: activity.contextual_metadata,
    ephemeral: activity.ephemeral,
    pushSummary: null,
    queued: activity.queued,
    sentAt: activity.sent_at,
    signal: activity.signal,
    signalMetadata: activity.signal_metadata,
    sourceMetadata: null,
    sourceComment: () =>
      activity.source_comment_id
        ? formatComment(context, requireComment(context.store, activity.source_comment_id))
        : null,
    archivedAt: activity.archived_at,
    createdAt: activity.created_at,
    updatedAt: activity.updated_at,
    agentSession,
    user: () => formatUser(context, requireUser(context.store, activity.user_id)),
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

type AgentActivityConnectionArgs = ConnectionArgs & {
  filter?: Record<string, unknown>;
  includeArchived?: boolean;
  orderBy?: string;
};

function connectAgentActivities(
  context: LinearGraphQLContext,
  items: LinearAgentActivity[],
  args: AgentActivityConnectionArgs,
) {
  const filtered = filterAgentActivities(items, args);
  return mapConnection(filtered, args, (item) => formatAgentActivity(context, item));
}

function filterAgentActivities(items: LinearAgentActivity[], args: AgentActivityConnectionArgs): LinearAgentActivity[] {
  const activities = args.includeArchived ? [...items] : items.filter((activity) => activity.archived_at === null);
  activities.sort((a, b) =>
    args.orderBy === "updatedAt" ? a.updated_at.localeCompare(b.updated_at) : a.created_at.localeCompare(b.created_at),
  );
  return args.filter ? activities.filter((activity) => agentActivityMatchesFilter(activity, args.filter!)) : activities;
}

function agentActivityMatchesFilter(activity: LinearAgentActivity, filter: Record<string, unknown>): boolean {
  const ownMatch =
    comparatorMatches(activity.linear_id, filter.id) &&
    comparatorMatches(activity.session_id, filter.agentSessionId) &&
    comparatorMatches(activity.content.type, filter.type);
  const andFilters = Array.isArray(filter.and) ? filter.and.filter(isRecord) : [];
  const orFilters = Array.isArray(filter.or) ? filter.or.filter(isRecord) : [];
  return (
    ownMatch &&
    andFilters.every((child) => agentActivityMatchesFilter(activity, child)) &&
    (orFilters.length === 0 || orFilters.some((child) => agentActivityMatchesFilter(activity, child)))
  );
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
  if (orderBy === "updatedAt") {
    teams = [...teams].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }
  if (!isRecord(filter)) return teams;
  return teams.filter((team) => teamMatchesFilter(team, filter));
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

function sortByPosition<T extends { position: number; created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

function requireCurrentUser(context: LinearGraphQLContext): LinearUser {
  const user = currentUser(context.store, context.c);
  if (!user) throw new Error("Linear user not found");
  return user;
}

function requireAgentAppActor(context: LinearGraphQLContext): LinearUser {
  const actor = requireCurrentUser(context);
  if (!actor.app) throw new Error("Agent mutations require an OAuth app actor");
  return actor;
}

function requireAgentSessionOwner(context: LinearGraphQLContext, session: LinearAgentSession, actor: LinearUser): void {
  const oauthClientId = oauthClientIdForAgent(context, actor.linear_id);
  if (session.agent_user_id !== actor.linear_id || session.oauth_client_id !== oauthClientId) {
    throw new Error("Agent session belongs to a different OAuth application");
  }
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

async function createAgentSessionForIssue(
  context: LinearGraphQLContext,
  issue: LinearIssue,
  agentUserId: string,
  actor: LinearUser | null,
  plan: LinearAgentPlanStep[] | null = null,
  links: SessionLinks = { external_link: null, external_urls: [] },
): Promise<LinearAgentSession> {
  const ls = getLinearStore(context.store);
  const oauthClientId = oauthClientIdForAgent(context, agentUserId);
  const existing = ls.agentSessions
    .findBy("issue_id", issue.linear_id)
    .find(
      (session) => session.agent_user_id === agentUserId && session.status !== "complete" && session.status !== "error",
    );
  if (existing) return existing;
  const session = ls.agentSessions.insert({
    linear_id: linearId(),
    issue_id: issue.linear_id,
    comment_id: null,
    agent_user_id: agentUserId,
    creator_id: actor?.linear_id ?? null,
    oauth_client_id: oauthClientId,
    status: "pending",
    plan,
    external_link: links.external_link,
    external_urls: links.external_urls,
    started_at: null,
    ended_at: null,
    summary: null,
  });
  await dispatchAgentSessionEvent(context, {
    action: "created",
    session,
    actor,
  });
  return session;
}

async function createAgentSessionForComment(
  context: LinearGraphQLContext,
  comment: LinearComment,
  agentUserId: string,
  actor: LinearUser | null,
  plan: LinearAgentPlanStep[] | null = null,
  links: SessionLinks = { external_link: null, external_urls: [] },
): Promise<LinearAgentSession> {
  const issue = requireIssue(context.store, comment.issue_id);
  const oauthClientId = oauthClientIdForAgent(context, agentUserId);
  const session = getLinearStore(context.store).agentSessions.insert({
    linear_id: linearId(),
    issue_id: issue.linear_id,
    comment_id: comment.linear_id,
    agent_user_id: agentUserId,
    creator_id: actor?.linear_id ?? null,
    oauth_client_id: oauthClientId,
    status: "pending",
    plan,
    external_link: links.external_link,
    external_urls: links.external_urls,
    started_at: null,
    ended_at: null,
    summary: null,
  });
  await dispatchAgentSessionEvent(context, {
    action: "created",
    session,
    actor,
  });
  return session;
}

function archiveEphemeralAgentActivities(
  context: LinearGraphQLContext,
  sessionId: string,
  currentActivityId: string,
  archivedAt: string,
): void {
  const activities = getLinearStore(context.store).agentActivities.findBy("session_id", sessionId);
  for (const activity of activities) {
    if (activity.linear_id !== currentActivityId && activity.ephemeral && activity.archived_at === null) {
      getLinearStore(context.store).agentActivities.update(activity.id, { archived_at: archivedAt });
    }
  }
}

async function deliverNextQueuedPrompt(
  context: LinearGraphQLContext,
  session: LinearAgentSession,
): Promise<LinearAgentSession> {
  const ls = getLinearStore(context.store);
  const queuedPrompt = sortByCreated(ls.agentActivities.findBy("session_id", session.linear_id)).find(
    (activity) => activity.queued && activity.sent_at === null && activity.archived_at === null,
  );
  if (!queuedPrompt) return session;

  const now = new Date().toISOString();
  const deliveredPrompt = ls.agentActivities.update(queuedPrompt.id, {
    queued: false,
    sent_at: now,
  })!;
  const activeSession = ls.agentSessions.update(session.id, {
    status: "active",
    started_at: session.started_at ?? now,
    ended_at: null,
  })!;
  await dispatchAgentSessionEvent(context, {
    action: "prompted",
    session: activeSession,
    activity: deliveredPrompt,
    actor: requireUser(context.store, deliveredPrompt.user_id),
  });
  return activeSession;
}

function oauthClientIdForAgent(context: LinearGraphQLContext, agentUserId: string): string {
  const ls = getLinearStore(context.store);
  const owningApp = ls.oauthApps.all().find((app) => app.app_user_id === agentUserId);
  if (owningApp) return owningApp.client_id;
  const requestToken = context.c.get("authToken");
  const token = requestToken ? ls.tokens.findOneBy("token", requestToken) : undefined;
  const authenticatedApp = token?.app_id ? ls.oauthApps.findOneBy("linear_id", token.app_id) : undefined;
  return authenticatedApp?.client_id ?? ls.oauthApps.all()[0]?.client_id ?? "linear-emulator";
}

function issueWebhookPayload(context: LinearGraphQLContext, issue: LinearIssue) {
  return {
    id: issue.linear_id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    teamId: issue.team_id,
    stateId: issue.state_id,
    assigneeId: issue.assignee_id,
    delegateId: issue.delegate_id,
    url: issue.url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    archivedAt: issue.archived_at,
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

function agentSessionWebhookPayload(
  context: LinearGraphQLContext,
  session: LinearAgentSession,
): LinearAgentSessionWebhookPayload {
  const organization = getLinearStore(context.store).organizations.all()[0];
  if (!organization) throw new Error("Linear organization has not been seeded");
  const issue = session.issue_id ? getLinearStore(context.store).issues.findOneBy("linear_id", session.issue_id) : null;
  const comment = session.comment_id
    ? getLinearStore(context.store).comments.findOneBy("linear_id", session.comment_id)
    : null;
  const creator = session.creator_id
    ? getLinearStore(context.store).users.findOneBy("linear_id", session.creator_id)
    : null;
  return {
    id: session.linear_id,
    appUserId: session.agent_user_id,
    organizationId: organization.linear_id,
    issueId: session.issue_id,
    commentId: session.comment_id,
    creatorId: session.creator_id,
    creator: creator ? userWebhookPayload(creator) : null,
    status: session.status,
    archivedAt: null,
    sourceCommentId: null,
    sourceMetadata: null,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    summary: session.summary,
    type: "commentThread",
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    url: issue?.url ?? null,
    issue: issue ? issueWebhookChildPayload(context, issue) : null,
    comment: comment ? commentWebhookChildPayload(comment) : null,
  };
}

function agentActivityWebhookPayload(
  context: LinearGraphQLContext,
  activity: LinearAgentActivity,
): LinearAgentActivityWebhookPayload {
  const user = requireUser(context.store, activity.user_id);
  return {
    id: activity.linear_id,
    agentSessionId: activity.session_id,
    content: activityContentAsJSON(activity.content),
    signal: activity.signal,
    signalMetadata: activity.signal_metadata ? ({ ...activity.signal_metadata } as Record<string, unknown>) : null,
    createdAt: activity.created_at,
    updatedAt: activity.updated_at,
    archivedAt: activity.archived_at,
    sourceCommentId: activity.source_comment_id,
    userId: activity.user_id,
    user: userWebhookPayload(user),
  };
}

function userWebhookPayload(user: LinearUser): LinearUserWebhookPayload {
  return {
    id: user.linear_id,
    url: `https://linear.app/user/${encodeURIComponent(user.email)}`,
    avatarUrl: user.avatar_url,
    email: user.email,
    name: user.name,
  };
}

function commentWebhookChildPayload(comment: LinearComment): LinearCommentWebhookPayload {
  return {
    id: comment.linear_id,
    body: comment.body,
    documentContentId: null,
    initiativeId: null,
    initiativeUpdateId: null,
    issueId: comment.issue_id,
    projectId: null,
    projectUpdateId: null,
    userId: comment.user_id,
  };
}

function issueWebhookChildPayload(context: LinearGraphQLContext, issue: LinearIssue): LinearIssueWebhookPayload {
  const team = requireTeam(context.store, issue.team_id);
  return {
    id: issue.linear_id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    teamId: issue.team_id,
    team: { id: team.linear_id, key: team.key, name: team.name },
  };
}

async function dispatchAgentSessionEvent(
  context: LinearGraphQLContext,
  opts: {
    action: "created" | "prompted";
    session: LinearAgentSession;
    activity?: LinearAgentActivity;
    actor: LinearUser | null;
  },
): Promise<void> {
  const issue = opts.session.issue_id
    ? getLinearStore(context.store).issues.findOneBy("linear_id", opts.session.issue_id)
    : null;
  const teamId = issue?.team_id ?? null;

  await dispatchLinearWebhook(context.store, {
    type: "AgentSessionEvent",
    action: opts.action,
    agentSession: agentSessionWebhookPayload(context, opts.session),
    agentActivity: opts.activity ? agentActivityWebhookPayload(context, opts.activity) : undefined,
    appUserId: opts.session.agent_user_id,
    oauthClientId: opts.session.oauth_client_id,
    // Essential context for agent loops; full Linear guidance/threads can come later.
    promptContext: opts.action === "created" ? buildPromptContext(context, opts.session) : null,
    guidance: [],
    previousComments:
      opts.action === "created" && opts.session.comment_id ? previousCommentsForSession(context, opts.session) : null,
    actor: opts.actor,
    teamId,
    url: issue?.url ?? null,
  });
}

function previousCommentsForSession(
  context: LinearGraphQLContext,
  session: LinearAgentSession,
): LinearCommentWebhookPayload[] {
  if (!session.comment_id || !session.issue_id) return [];
  const comments = sortByCreated(getLinearStore(context.store).comments.findBy("issue_id", session.issue_id));
  const sessionCommentIndex = comments.findIndex((comment) => comment.linear_id === session.comment_id);
  return comments.slice(0, sessionCommentIndex < 0 ? 0 : sessionCommentIndex).map(commentWebhookChildPayload);
}

function buildPromptContext(context: LinearGraphQLContext, session: LinearAgentSession): string {
  if (!session.issue_id) return "";
  const issue = requireIssue(context.store, session.issue_id);
  const team = requireTeam(context.store, issue.team_id);
  const ls = getLinearStore(context.store);
  const parts = [`<issue identifier="${escapeAttr(issue.identifier)}">`, `<title>${escapeHtml(issue.title)}</title>`];
  if (issue.description) parts.push(`<description>${escapeHtml(issue.description)}</description>`);
  parts.push(`<team name="${escapeAttr(team.name)}"/>`);
  for (const labelId of issue.label_ids) {
    const label = ls.issueLabels.findOneBy("linear_id", labelId);
    if (label) parts.push(`<label>${escapeHtml(label.name)}</label>`);
  }
  if (issue.project_id) {
    const project = ls.projects.findOneBy("linear_id", issue.project_id);
    if (project) {
      parts.push(
        `<project name="${escapeAttr(project.name)}">${project.description ? escapeHtml(project.description) : ""}</project>`,
      );
    }
  }
  parts.push(`</issue>`);
  if (session.comment_id) {
    const comment = requireComment(context.store, session.comment_id);
    const author = comment.user_id ? ls.users.findOneBy("linear_id", comment.user_id) : undefined;
    const user = author ? `<user id="${escapeAttr(author.linear_id)}">${escapeHtml(author.display_name)}</user> ` : "";
    parts.push(
      `<primary-directive-thread comment-id="${escapeAttr(comment.linear_id)}"><comment author="${escapeAttr(author?.name ?? "Unknown")}" created-at="${escapeAttr(comment.created_at)}">${user}${escapeHtml(comment.body)}</comment></primary-directive-thread>`,
    );
  }
  return parts.join("\n");
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

function recordInput(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
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
