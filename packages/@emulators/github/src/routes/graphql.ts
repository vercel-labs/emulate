import { buildSchema, graphql } from "graphql";
import type { RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubComment, GitHubPullRequest } from "../entities.js";
import { formatComment, formatPullRequest, formatRepo, formatUser, generateNodeId, lookupRepo } from "../helpers.js";
import {
  assertRepoPermission,
  assertRepoWrite,
  getActorUser,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";
import { validateReviewCommentLocation } from "./comments.js";

const schema = buildSchema(`
  type Query { repository(owner: String!, name: String!): Repository }
  type Repository { pullRequest(number: Int!): PullRequest }
  type PullRequest {
    id: ID!
    number: Int!
    title: String!
    body: String!
    state: String!
    isDraft: Boolean!
    reviewThreads(first: Int!, after: String): ReviewThreadConnection!
  }
  type ReviewThreadConnection { nodes: [PullRequestReviewThread!]!, pageInfo: PageInfo! }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type User { databaseId: Int!, login: String!, avatarUrl: String! }
  type PullRequestReviewThread { id: ID!, isResolved: Boolean!, resolvedBy: User, comments(first: Int!): CommentConnection! }
  type CommentConnection { nodes: [PullRequestReviewComment!]! }
  type PullRequestReviewComment { id: ID!, databaseId: Int!, body: String!, url: String! }
  enum DiffSide { LEFT RIGHT }
  enum PullRequestReviewThreadSubjectType { LINE FILE }
  input AddPullRequestReviewThreadInput {
    pullRequestReviewId: ID!, body: String!, path: String!, line: Int, side: DiffSide,
    startLine: Int, startSide: DiffSide, subjectType: PullRequestReviewThreadSubjectType, clientMutationId: String
  }
  input ConvertPullRequestToDraftInput { pullRequestId: ID!, clientMutationId: String }
  input MarkPullRequestReadyForReviewInput { pullRequestId: ID!, clientMutationId: String }
  input ResolveReviewThreadInput { threadId: ID!, clientMutationId: String }
  input UnresolveReviewThreadInput { threadId: ID!, clientMutationId: String }
  type PullRequestPayload { pullRequest: PullRequest!, clientMutationId: String }
  type ReviewThreadPayload { thread: PullRequestReviewThread!, clientMutationId: String }
  type Mutation {
    addPullRequestReviewThread(input: AddPullRequestReviewThreadInput!): ReviewThreadPayload!
    convertPullRequestToDraft(input: ConvertPullRequestToDraftInput!): PullRequestPayload!
    markPullRequestReadyForReview(input: MarkPullRequestReadyForReviewInput!): PullRequestPayload!
    resolveReviewThread(input: ResolveReviewThreadInput!): ReviewThreadPayload!
    unresolveReviewThread(input: UnresolveReviewThreadInput!): ReviewThreadPayload!
  }
`);

export function graphqlRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  function threadNode(root: GitHubComment) {
    return {
      id: generateNodeId("PullRequestReviewThread", root.id),
      isResolved: root.resolved ?? false,
      resolvedBy: root.resolved_by
        ? (() => {
            const user = gh.users.get(root.resolved_by);
            return user
              ? { databaseId: user.id, login: user.login, avatarUrl: formatUser(user, baseUrl).avatar_url }
              : null;
          })()
        : null,
      comments: ({ first }: { first: number }) => ({
        nodes: [
          root,
          ...gh.comments.findBy("repo_id", root.repo_id).filter((comment) => comment.in_reply_to_id === root.id),
        ]
          .slice(0, first)
          .map((comment) => ({
            id: comment.node_id,
            databaseId: comment.id,
            body: comment.body,
            url: formatComment(comment, gh, baseUrl)?.html_url,
          })),
      }),
    };
  }

  function pullNode(pr: GitHubPullRequest, viewerId?: number) {
    return {
      id: pr.node_id,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.merged ? "MERGED" : pr.state.toUpperCase(),
      isDraft: pr.draft,
      reviewThreads: ({ first, after }: { first: number; after?: string }) => {
        if (first < 1 || first > 100) throw new Error("first must be between 1 and 100");
        const roots = gh.comments
          .findBy("repo_id", pr.repo_id)
          .filter(
            (comment) =>
              comment.comment_type === "review" &&
              comment.pull_number === pr.number &&
              !comment.in_reply_to_id &&
              (!comment.review_id ||
                gh.reviews.get(comment.review_id)?.state !== "PENDING" ||
                comment.user_id === viewerId),
          )
          .sort((a, b) => a.id - b.id);
        const start = after ? roots.findIndex((comment) => String(comment.id) === after) + 1 : 0;
        const page = roots.slice(start, start + first);
        return {
          nodes: page.map(threadNode),
          pageInfo: {
            hasNextPage: start + first < roots.length,
            endCursor: page.length ? String(page[page.length - 1]!.id) : null,
          },
        };
      },
    };
  }

  app.post("/graphql", async (c) => {
    const raw = await parseJsonBody(c);
    const auth = c.get("authUser");

    function addThread(input: {
      pullRequestReviewId: string;
      body: string;
      path: string;
      line?: number;
      side?: "LEFT" | "RIGHT";
      startLine?: number;
      startSide?: "LEFT" | "RIGHT";
      subjectType?: "LINE" | "FILE";
      clientMutationId?: string;
    }) {
      const review = gh.reviews.all().find((candidate) => candidate.node_id === input.pullRequestReviewId);
      if (!review) throw notFoundResponse();
      const repo = gh.repos.get(review.repo_id)!;
      const actor = assertRepoWrite(gh, auth, repo, "pull_requests");
      if (review.user_id !== actor.id || review.state !== "PENDING")
        throw new Error("Only the reviewer can add comments to a pending review");
      const pr = gh.pullRequests
        .findBy("repo_id", repo.id)
        .find((candidate) => candidate.number === review.pull_number);
      if (!pr || pr.state !== "open") throw new Error("Pull request is not open");
      const subjectType = input.subjectType === "FILE" ? "file" : "line";
      validateReviewCommentLocation(gh, pr, pr.head_sha, input.path, {
        line: input.line,
        side: input.side ?? "RIGHT",
        start_line: input.startLine,
        start_side: input.startSide,
        subject_type: subjectType,
      });
      const row = gh.comments.insert({
        node_id: "",
        repo_id: repo.id,
        issue_number: null,
        pull_number: pr.number,
        commit_sha: pr.head_sha,
        body: input.body,
        user_id: actor.id,
        in_reply_to_id: null,
        path: input.path,
        position: null,
        line: input.line ?? null,
        side: input.side ?? "RIGHT",
        subject_type: subjectType,
        comment_type: "review",
        review_id: review.id,
      } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
      gh.comments.update(row.id, { node_id: generateNodeId("PullRequestReviewComment", row.id) });
      return { thread: threadNode(gh.comments.get(row.id)!), clientMutationId: input.clientMutationId };
    }

    function changeDraft(input: { pullRequestId: string; clientMutationId?: string }, draft: boolean) {
      const pr = gh.pullRequests.all().find((candidate) => candidate.node_id === input.pullRequestId);
      if (!pr) throw notFoundResponse();
      const repo = gh.repos.get(pr.repo_id)!;
      const actor = assertRepoWrite(gh, auth, repo, "pull_requests");
      if (pr.state !== "open") throw new Error("Pull request is not open");
      if (pr.draft !== draft) {
        gh.pullRequests.update(pr.id, { draft });
        const action = draft ? "converted_to_draft" : "ready_for_review";
        webhooks.dispatch(
          "pull_request",
          action,
          {
            action,
            pull_request: formatPullRequest(gh.pullRequests.get(pr.id)!, gh, baseUrl),
            repository: formatRepo(repo, gh, baseUrl),
            sender: formatUser(actor, baseUrl),
          },
          ownerLoginOf(gh, repo),
          repo.name,
        );
      }
      return { pullRequest: pullNode(gh.pullRequests.get(pr.id)!), clientMutationId: input.clientMutationId };
    }

    function changeResolution(input: { threadId: string; clientMutationId?: string }, resolved: boolean) {
      const root = gh.comments
        .all()
        .find(
          (comment) =>
            comment.comment_type === "review" &&
            !comment.in_reply_to_id &&
            generateNodeId("PullRequestReviewThread", comment.id) === input.threadId,
        );
      if (!root) throw notFoundResponse();
      const repo = gh.repos.get(root.repo_id)!;
      const actor = assertRepoWrite(gh, auth, repo, "pull_requests");
      const pr = gh.pullRequests.findBy("repo_id", repo.id).find((candidate) => candidate.number === root.pull_number);
      if (!pr) throw notFoundResponse();
      if ((root.resolved ?? false) !== resolved) {
        gh.comments.update(root.id, { resolved, resolved_by: resolved ? actor.id : null });
        const action = resolved ? "resolved" : "unresolved";
        webhooks.dispatch(
          "pull_request_review_thread",
          action,
          {
            action,
            thread: { id: root.id, node_id: input.threadId, comments: [formatComment(root, gh, baseUrl)] },
            pull_request: formatPullRequest(pr, gh, baseUrl),
            repository: formatRepo(repo, gh, baseUrl),
            sender: formatUser(actor, baseUrl),
          },
          ownerLoginOf(gh, repo),
          repo.name,
        );
      }
      return { thread: threadNode(gh.comments.get(root.id)!), clientMutationId: input.clientMutationId };
    }

    return c.json(
      await graphql({
        schema,
        source: typeof raw.query === "string" ? raw.query : "",
        variableValues: raw.variables as Record<string, unknown> | undefined,
        operationName: typeof raw.operationName === "string" ? raw.operationName : undefined,
        rootValue: {
          repository: ({ owner, name }: { owner: string; name: string }) => {
            const repo = lookupRepo(gh, owner, name);
            if (!repo) return null;
            assertRepoPermission(gh, auth, repo, "pull_requests");
            return {
              pullRequest: ({ number }: { number: number }) => {
                const pr = gh.pullRequests.findBy("repo_id", repo.id).find((candidate) => candidate.number === number);
                return pr ? pullNode(pr, auth ? getActorUser(gh, auth)?.id : undefined) : null;
              },
            };
          },
          convertPullRequestToDraft: ({ input }: { input: { pullRequestId: string } }) => changeDraft(input, true),
          addPullRequestReviewThread: ({ input }: { input: Parameters<typeof addThread>[0] }) => addThread(input),
          markPullRequestReadyForReview: ({ input }: { input: { pullRequestId: string } }) => changeDraft(input, false),
          resolveReviewThread: ({ input }: { input: { threadId: string } }) => changeResolution(input, true),
          unresolveReviewThread: ({ input }: { input: { threadId: string } }) => changeResolution(input, false),
        },
      }),
    );
  });
}
