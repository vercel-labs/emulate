/**
 * The intentionally small GraphQL schema exposed by the GitHub emulator.
 *
 * This is a schema based compatibility surface. Keeping the SDL in its own
 * module makes the supported subset explicit and lets later issue-graph lanes
 * extend it without coupling transport parsing to resolver implementation.
 */
export const githubGraphQLSchema = /* GraphQL */ `
  scalar DateTime

  interface Node {
    id: ID!
  }

  interface Actor {
    id: ID!
    login: String!
  }

  type User implements Actor {
    id: ID!
    login: String!
    name: String
  }

  type Organization implements Actor {
    id: ID!
    login: String!
    name: String
  }

  type Bot implements Actor {
    id: ID!
    login: String!
    name: String
  }

  type Repository implements Node {
    id: ID!
    name: String!
    nameWithOwner: String!
    url: String!
    isPrivate: Boolean!
    owner: Actor
    issue(number: Int!): Issue
    label(name: String!): Label
  }

  enum IssueState {
    OPEN
    CLOSED
  }

  enum IssueStateReason {
    COMPLETED
    DUPLICATE
    NOT_PLANNED
    REOPENED
  }

  type Issue implements Node {
    id: ID!
    number: Int!
    title: String!
    body: String
    state: IssueState!
    stateReason(enableDuplicate: Boolean = false): IssueStateReason
    repository: Repository!
    author: Actor
    createdAt: DateTime!
    updatedAt: DateTime!
    url: String!
    comments(first: Int, after: String, last: Int, before: String): IssueCommentConnection!
    parent: Issue
    subIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
    blockedBy(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Label implements Node {
    id: ID!
    name: String!
    description: String
    color: String!
    repository: Repository!
  }

  type IssueComment implements Node {
    id: ID!
    body: String!
    author: Actor
    createdAt: DateTime!
    updatedAt: DateTime!
    issue: Issue
    repository: Repository!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type IssueCommentEdge {
    cursor: String!
    node: IssueComment!
  }

  type IssueCommentConnection {
    nodes: [IssueComment!]!
    edges: [IssueCommentEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type IssueEdge {
    cursor: String!
    node: Issue!
  }

  type IssueConnection {
    nodes: [Issue!]!
    edges: [IssueEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type RateLimit {
    limit: Int!
    remaining: Int!
    used: Int!
    resetAt: DateTime!
    cost: Int!
  }

  input AddSubIssueInput {
    parentIssueId: ID!
    childIssueId: ID!
    replaceParent: Boolean = false
    clientMutationId: String
  }

  type AddSubIssuePayload {
    parentIssue: Issue!
    subIssue: Issue!
    childIssue: Issue!
    clientMutationId: String
  }

  input AddBlockedByInput {
    issueId: ID
    blockedIssueId: ID
    blockingIssueId: ID!
    clientMutationId: String
  }

  type AddBlockedByPayload {
    issue: Issue!
    blockedIssue: Issue!
    blockedBy: Issue!
    blockingIssue: Issue!
    clientMutationId: String
  }

  type Query {
    repository(owner: String!, name: String!): Repository
    node(id: ID!): Node
    rateLimit: RateLimit!
  }

  type Mutation {
    addSubIssue(input: AddSubIssueInput!): AddSubIssuePayload!
    addBlockedBy(input: AddBlockedByInput!): AddBlockedByPayload!
  }
`;
