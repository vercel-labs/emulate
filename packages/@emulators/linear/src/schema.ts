import { buildSchema } from "graphql";

export const linearSchema = buildSchema(`
  scalar DateTime

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type Organization {
    id: ID!
    name: String!
    urlKey: String
    createdAt: DateTime!
    updatedAt: DateTime!
    teams(first: Int, after: String, last: Int, before: String): TeamConnection!
    users(first: Int, after: String, last: Int, before: String): UserConnection!
  }

  type User {
    id: ID!
    name: String!
    email: String!
    displayName: String
    active: Boolean!
    admin: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    organization: Organization
    assignedIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
    createdIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
    projectsLed(first: Int, after: String, last: Int, before: String): ProjectConnection!
  }

  type Team {
    id: ID!
    name: String!
    key: String!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
    organization: Organization!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
    labels(first: Int, after: String, last: Int, before: String): LabelConnection!
    workflowStates(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
  }

  type WorkflowState {
    id: ID!
    name: String!
    type: String!
    position: Float!
    color: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    team: Team!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Label {
    id: ID!
    name: String!
    color: String!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
    team: Team
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Project {
    id: ID!
    name: String!
    description: String
    slugId: String!
    state: String!
    targetDate: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
    team: Team
    lead: User
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Issue {
    id: ID!
    identifier: String!
    number: Float!
    title: String!
    description: String
    priority: Float!
    estimate: Float
    url: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    team: Team!
    state: WorkflowState
    assignee: User
    creator: User
    project: Project
    labels(first: Int, after: String, last: Int, before: String): LabelConnection!
  }

  type OrganizationEdge { node: Organization!, cursor: String! }
  type OrganizationConnection { edges: [OrganizationEdge!]!, nodes: [Organization!]!, pageInfo: PageInfo! }

  type UserEdge { node: User!, cursor: String! }
  type UserConnection { edges: [UserEdge!]!, nodes: [User!]!, pageInfo: PageInfo! }

  type TeamEdge { node: Team!, cursor: String! }
  type TeamConnection { edges: [TeamEdge!]!, nodes: [Team!]!, pageInfo: PageInfo! }

  type WorkflowStateEdge { node: WorkflowState!, cursor: String! }
  type WorkflowStateConnection { edges: [WorkflowStateEdge!]!, nodes: [WorkflowState!]!, pageInfo: PageInfo! }

  type LabelEdge { node: Label!, cursor: String! }
  type LabelConnection { edges: [LabelEdge!]!, nodes: [Label!]!, pageInfo: PageInfo! }

  type ProjectEdge { node: Project!, cursor: String! }
  type ProjectConnection { edges: [ProjectEdge!]!, nodes: [Project!]!, pageInfo: PageInfo! }

  type IssueEdge { node: Issue!, cursor: String! }
  type IssueConnection { edges: [IssueEdge!]!, nodes: [Issue!]!, pageInfo: PageInfo! }

  type Query {
    viewer: User
    organization(id: ID): Organization
    organizations(first: Int, after: String, last: Int, before: String): OrganizationConnection!
    user(id: ID!): User
    users(first: Int, after: String, last: Int, before: String): UserConnection!
    team(id: ID!): Team
    teams(first: Int, after: String, last: Int, before: String): TeamConnection!
    workflowState(id: ID!): WorkflowState
    workflowStates(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    label(id: ID!): Label
    labels(first: Int, after: String, last: Int, before: String): LabelConnection!
    project(id: ID!): Project
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
    issue(id: ID, identifier: String): Issue
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }
`);
