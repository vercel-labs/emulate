import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema as githubSchema } from "@octokit/graphql-schema";
import { Kind, buildASTSchema, parse, print } from "graphql";
import { format, resolveConfig } from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../src/graphql/schema.ts");

const actor = ["avatarUrl", "login", "resourcePath", "url"];
const connection = ["edges", "nodes", "pageInfo", "totalCount"];
const edge = ["cursor", "node"];

export const manifest = {
  Query: [
    "id",
    "node",
    "nodes",
    "organization",
    "rateLimit",
    "repository",
    "repositoryOwner",
    "search",
    "user",
    "viewer",
  ],
  Mutation: [
    "addComment",
    "addLabelsToLabelable",
    "addPullRequestReview",
    "closePullRequest",
    "convertPullRequestToDraft",
    "createPullRequest",
    "deleteIssueComment",
    "markPullRequestReadyForReview",
    "mergePullRequest",
    "removeLabelsFromLabelable",
    "reopenPullRequest",
    "requestReviews",
    "submitPullRequestReview",
    "updateIssueComment",
    "updatePullRequest",
  ],
  Node: ["id"],
  Actor: actor,
  RepositoryOwner: ["avatarUrl", "id", "login", "repository", "resourcePath", "url"],
  GitObject: ["abbreviatedOid", "id", "oid"],
  RequirableByPullRequest: ["isRequired"],
  User: [
    ...actor,
    "bio",
    "company",
    "createdAt",
    "databaseId",
    "email",
    "id",
    "isSiteAdmin",
    "isViewer",
    "location",
    "name",
    "organizations",
    "repository",
    "updatedAt",
  ],
  Bot: [...actor, "createdAt", "databaseId", "id", "updatedAt"],
  Organization: [...actor, "createdAt", "databaseId", "description", "email", "id", "name", "repository", "updatedAt"],
  Team: ["databaseId", "id", "name", "organization", "slug", "url"],
  Repository: [
    "assignableUsers",
    "autoMergeAllowed",
    "createdAt",
    "databaseId",
    "defaultBranchRef",
    "deleteBranchOnMerge",
    "description",
    "forkCount",
    "hasDiscussionsEnabled",
    "hasIssuesEnabled",
    "hasProjectsEnabled",
    "hasWikiEnabled",
    "homepageUrl",
    "id",
    "isArchived",
    "isEmpty",
    "isFork",
    "isInOrganization",
    "isPrivate",
    "isTemplate",
    "label",
    "labels",
    "mentionableUsers",
    "mergeCommitAllowed",
    "milestone",
    "milestones",
    "name",
    "nameWithOwner",
    "owner",
    "parent",
    "pullRequest",
    "pullRequestTemplates",
    "pullRequests",
    "pushedAt",
    "rebaseMergeAllowed",
    "ref",
    "resourcePath",
    "squashMergeAllowed",
    "sshUrl",
    "stargazerCount",
    "updatedAt",
    "url",
    "viewerCanAdminister",
    "viewerDefaultMergeMethod",
    "viewerPermission",
    "visibility",
  ],
  PullRequest: [
    "additions",
    "assignees",
    "author",
    "authorAssociation",
    "autoMergeRequest",
    "baseRef",
    "baseRefName",
    "baseRefOid",
    "baseRepository",
    "body",
    "bodyText",
    "changedFiles",
    "closed",
    "closedAt",
    "closingIssuesReferences",
    "comments",
    "commits",
    "createdAt",
    "databaseId",
    "deletions",
    "files",
    "fullDatabaseId",
    "headRef",
    "headRefName",
    "headRefOid",
    "headRepository",
    "headRepositoryOwner",
    "id",
    "isCrossRepository",
    "isDraft",
    "isInMergeQueue",
    "isMergeQueueEnabled",
    "labels",
    "latestReviews",
    "locked",
    "maintainerCanModify",
    "mergeCommit",
    "mergeStateStatus",
    "mergeable",
    "merged",
    "mergedAt",
    "mergedBy",
    "milestone",
    "number",
    "permalink",
    "potentialMergeCommit",
    "reactionGroups",
    "repository",
    "resourcePath",
    "reviewDecision",
    "reviewRequests",
    "reviews",
    "state",
    "statusCheckRollup",
    "title",
    "updatedAt",
    "url",
    "viewerDidAuthor",
  ],
  Issue: ["id", "labels", "number", "repository", "resourcePath", "state", "title", "url"],
  IssueComment: [
    "author",
    "authorAssociation",
    "body",
    "createdAt",
    "databaseId",
    "id",
    "includesCreatedEdit",
    "isMinimized",
    "issue",
    "minimizedReason",
    "pullRequest",
    "reactionGroups",
    "repository",
    "resourcePath",
    "updatedAt",
    "url",
    "viewerDidAuthor",
  ],
  PullRequestReview: [
    "author",
    "authorAssociation",
    "body",
    "commit",
    "createdAt",
    "databaseId",
    "id",
    "includesCreatedEdit",
    "isMinimized",
    "minimizedReason",
    "pullRequest",
    "reactionGroups",
    "repository",
    "resourcePath",
    "state",
    "submittedAt",
    "updatedAt",
    "url",
    "viewerDidAuthor",
  ],
  ReviewRequest: ["id", "requestedReviewer"],
  Label: ["color", "description", "id", "isDefault", "name", "url"],
  Milestone: ["description", "dueOn", "id", "number", "state", "title", "url"],
  Ref: ["branchProtectionRule", "id", "name", "prefix", "repository", "target"],
  BranchProtectionRule: [
    "id",
    "pattern",
    "requiredApprovingReviewCount",
    "requiredStatusCheckContexts",
    "requiresApprovingReviews",
    "requiresStatusChecks",
    "requiresStrictStatusChecks",
  ],
  Commit: [
    "abbreviatedOid",
    "author",
    "authoredDate",
    "authors",
    "committedDate",
    "committer",
    "id",
    "message",
    "messageBody",
    "messageHeadline",
    "oid",
    "statusCheckRollup",
    "url",
  ],
  GitActor: ["date", "email", "name", "user"],
  PullRequestCommit: ["commit", "id", "pullRequest", "url"],
  PullRequestChangedFile: ["additions", "changeType", "deletions", "path"],
  StatusCheckRollup: ["commit", "contexts", "id", "state"],
  CheckRun: [
    "checkSuite",
    "completedAt",
    "conclusion",
    "databaseId",
    "detailsUrl",
    "id",
    "isRequired",
    "name",
    "permalink",
    "startedAt",
    "status",
    "title",
    "url",
  ],
  CheckSuite: ["id", "workflowRun"],
  WorkflowRun: ["event", "id", "workflow"],
  Workflow: ["id", "name"],
  StatusContext: ["context", "createdAt", "description", "id", "isRequired", "state", "targetUrl"],
  CheckRunStateCount: ["count", "state"],
  StatusContextStateCount: ["count", "state"],
  ReactionGroup: ["content", "users"],
  ReactingUserConnection: ["totalCount"],
  AutoMergeRequest: ["authorEmail", "commitBody", "commitHeadline", "enabledAt", "enabledBy", "mergeMethod"],
  PullRequestTemplate: ["body", "filename"],
  RateLimit: ["cost", "limit", "nodeCount", "remaining", "resetAt", "used"],
  PageInfo: ["endCursor", "hasNextPage", "hasPreviousPage", "startCursor"],
  PullRequestConnection: connection,
  PullRequestEdge: edge,
  IssueConnection: connection,
  IssueEdge: edge,
  IssueCommentConnection: connection,
  IssueCommentEdge: edge,
  PullRequestReviewConnection: connection,
  PullRequestReviewEdge: edge,
  ReviewRequestConnection: connection,
  ReviewRequestEdge: edge,
  LabelConnection: connection,
  LabelEdge: edge,
  MilestoneConnection: connection,
  MilestoneEdge: edge,
  UserConnection: connection,
  UserEdge: ["cursor", "node"],
  OrganizationConnection: connection,
  OrganizationEdge: edge,
  PullRequestCommitConnection: connection,
  PullRequestCommitEdge: edge,
  PullRequestChangedFileConnection: connection,
  PullRequestChangedFileEdge: edge,
  GitActorConnection: connection,
  GitActorEdge: edge,
  StatusCheckRollupContextConnection: [
    ...connection,
    "checkRunCount",
    "checkRunCountsByState",
    "statusContextCount",
    "statusContextCountsByState",
  ],
  StatusCheckRollupContextEdge: edge,
  SearchResultItemConnection: ["edges", "issueCount", "nodes", "pageInfo"],
  SearchResultItemEdge: edge,
  AddCommentPayload: ["clientMutationId", "commentEdge", "subject"],
  AddLabelsToLabelablePayload: ["clientMutationId", "labelable"],
  AddPullRequestReviewPayload: ["clientMutationId", "pullRequestReview"],
  ClosePullRequestPayload: ["clientMutationId", "pullRequest"],
  ConvertPullRequestToDraftPayload: ["clientMutationId", "pullRequest"],
  CreatePullRequestPayload: ["clientMutationId", "pullRequest"],
  DeleteIssueCommentPayload: ["clientMutationId"],
  MarkPullRequestReadyForReviewPayload: ["clientMutationId", "pullRequest"],
  MergePullRequestPayload: ["actor", "clientMutationId", "pullRequest"],
  RemoveLabelsFromLabelablePayload: ["clientMutationId", "labelable"],
  ReopenPullRequestPayload: ["clientMutationId", "pullRequest"],
  RequestReviewsPayload: ["actor", "clientMutationId", "pullRequest"],
  SubmitPullRequestReviewPayload: ["clientMutationId", "pullRequestReview"],
  UpdateIssueCommentPayload: ["clientMutationId", "issueComment"],
  UpdatePullRequestPayload: ["actor", "clientMutationId", "pullRequest"],
  Labelable: ["labels"],
  Assignee: [],
};

// Fields and operations gh sends to github.com-class hosts that are missing from the public schema.
export const extensions = `
extend type PullRequest {
  assignedActors(after: String, before: String, first: Int, last: Int): AssigneeConnection!
}

extend type Issue {
  assignedActors(after: String, before: String, first: Int, last: Int): AssigneeConnection!
}

type AssigneeConnection {
  edges: [AssigneeEdge]
  nodes: [Assignee]
  pageInfo: PageInfo!
  totalCount: Int!
}

type AssigneeEdge {
  cursor: String!
  node: Assignee
}

extend type Mutation {
  replaceActorsForAssignable(input: ReplaceActorsForAssignableInput!): ReplaceActorsForAssignablePayload
  requestReviewsByLogin(input: RequestReviewsByLoginInput!): RequestReviewsByLoginPayload
}

input ReplaceActorsForAssignableInput {
  actorLogins: [String!]!
  assignableId: ID!
  clientMutationId: String
}

type ReplaceActorsForAssignablePayload {
  clientMutationId: String
}

input RequestReviewsByLoginInput {
  botLogins: [String!]
  clientMutationId: String
  pullRequestId: ID!
  teamSlugs: [String!]
  union: Boolean!
  userLogins: [String!]
}

type RequestReviewsByLoginPayload {
  clientMutationId: String
  pullRequest: PullRequest
}
`;

function namedType(typeNode) {
  let t = typeNode;
  while (t.kind !== Kind.NAMED_TYPE) t = t.type;
  return t.name.value;
}

function stripDirectives(node) {
  const directives = (node.directives ?? []).filter((d) => d.name.value === "deprecated");
  return { ...node, description: undefined, directives };
}

export function buildPrunedSdl(sourceSdl) {
  const doc = parse(sourceSdl);
  const defs = new Map();
  for (const def of doc.definitions) {
    if ("name" in def && def.name) defs.set(def.name.value, def);
  }

  const output = new Map();
  const queue = [];
  const builtins = new Set(["String", "Int", "Float", "Boolean", "ID"]);

  const want = (name) => {
    if (builtins.has(name) || output.has(name) || queue.includes(name)) return;
    queue.push(name);
  };

  for (const name of Object.keys(manifest)) want(name);

  const objectLike = new Set([Kind.OBJECT_TYPE_DEFINITION, Kind.INTERFACE_TYPE_DEFINITION]);

  while (queue.length > 0) {
    const name = queue.shift();
    const def = defs.get(name);
    if (!def) throw new Error(`Type ${name} is not in GitHub's schema`);

    if (objectLike.has(def.kind)) {
      const fields = manifest[name];
      if (!fields) throw new Error(`Type ${name} is referenced but has no manifest entry`);
      const kept = def.fields.filter((f) => fields.includes(f.name.value));
      const missing = fields.filter((f) => !kept.some((k) => k.name.value === f));
      if (missing.length) throw new Error(`${name} has no fields: ${missing.join(", ")}`);
      for (const field of kept) {
        want(namedType(field.type));
        for (const arg of field.arguments ?? []) want(namedType(arg.type));
      }
      output.set(name, {
        ...stripDirectives(def),
        interfaces: def.interfaces,
        fields: kept.map((f) => ({
          ...stripDirectives(f),
          arguments: (f.arguments ?? []).map(stripDirectives),
        })),
      });
    } else if (def.kind === Kind.UNION_TYPE_DEFINITION) {
      output.set(name, stripDirectives(def));
    } else if (def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION) {
      for (const field of def.fields) want(namedType(field.type));
      output.set(name, { ...stripDirectives(def), fields: def.fields.map(stripDirectives) });
    } else if (def.kind === Kind.ENUM_TYPE_DEFINITION) {
      output.set(name, { ...stripDirectives(def), values: def.values.map(stripDirectives) });
    } else {
      output.set(name, stripDirectives(def));
    }
  }

  const problems = [];
  for (const [name, def] of output) {
    if (objectLike.has(def.kind)) {
      const interfaces = (def.interfaces ?? []).filter((i) => output.has(i.name.value));
      for (const iface of interfaces) {
        const required = manifest[iface.name.value];
        const missing = required.filter((f) => !def.fields.some((k) => k.name.value === f));
        if (missing.length) problems.push(`${name} implements ${iface.name.value} but lacks: ${missing.join(", ")}`);
      }
      output.set(name, { ...def, interfaces });
    } else if (def.kind === Kind.UNION_TYPE_DEFINITION) {
      output.set(name, { ...def, types: def.types.filter((t) => output.has(t.name.value)) });
    }
  }

  if (problems.length) throw new Error(problems.join("\n"));

  const sorted = [...output.keys()].sort().map((k) => output.get(k));
  const sdl = print({ kind: Kind.DOCUMENT, definitions: sorted });
  return `${sdl}\n${extensions.trim()}\n`;
}

function render(sdl) {
  return [
    "// Generated by scripts/generate-graphql-schema.mjs from @octokit/graphql-schema. Do not edit.",
    "export const typeDefs = /* GraphQL */ `",
    sdl.replace(/`/g, "\\`").trimEnd(),
    "`;",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sdl = buildPrunedSdl(githubSchema.idl);
  buildASTSchema(parse(sdl));
  const rendered = await format(render(sdl), { ...(await resolveConfig(outPath)), filepath: outPath });
  if (process.argv.includes("--check")) {
    if (readFileSync(outPath, "utf8") !== rendered) {
      console.error("src/graphql/schema.ts is out of date; run node scripts/generate-graphql-schema.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(outPath, rendered);
  }
}
