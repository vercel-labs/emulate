import type { Context } from "@emulators/core";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubComment, GitHubCommit, GitHubIssue, GitHubPullRequest, GitHubRepo } from "../entities.js";
import { blobText, diffText, findCommitBySha, flattenTree } from "../git-helpers.js";
import {
  formatComment,
  formatIssue,
  formatPullRequest,
  formatRepo,
  formatUser,
  generateNodeId,
  lookupRepo,
} from "../helpers.js";
import {
  assertRepoContentsRead,
  assertRepoPermission,
  assertRepoWrite,
  getActorUser,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

function findIssueByNumber(gh: GitHubStore, repoId: number, number: number): GitHubIssue | undefined {
  return gh.issues.findBy("repo_id", repoId).find((i) => i.number === number);
}

function findPull(gh: GitHubStore, repoId: number, pullNumber: number): GitHubPullRequest | undefined {
  return gh.pullRequests.findBy("repo_id", repoId).find((p) => p.number === pullNumber);
}

function findCommitInRepo(gh: GitHubStore, repoId: number, shaParam: string): GitHubCommit | undefined {
  const want = shaParam.toLowerCase();
  const list = gh.commits.findBy("repo_id", repoId);
  return list.find((c) => c.sha === shaParam || c.sha.toLowerCase() === want || c.sha.startsWith(shaParam));
}

function getCommentForRepo(
  gh: GitHubStore,
  repo: GitHubRepo,
  commentId: number,
  kind: GitHubComment["comment_type"],
): GitHubComment | undefined {
  const c = gh.comments.get(commentId);
  if (!c || c.repo_id !== repo.id || c.comment_type !== kind) return undefined;
  return c;
}

function sortComments(
  comments: GitHubComment[],
  sort: "created" | "updated",
  direction: "asc" | "desc",
): GitHubComment[] {
  const mul = direction === "asc" ? 1 : -1;
  const field = sort === "created" ? "created_at" : "updated_at";
  const sorted = [...comments];
  sorted.sort((a, b) => {
    const as = a[field];
    const bs = b[field];
    if (as < bs) return -1 * mul;
    if (as > bs) return 1 * mul;
    return a.id < b.id ? -1 * mul : a.id > b.id ? 1 * mul : 0;
  });
  return sorted;
}

function parseCommentSort(c: Context, defaultDirection: "asc" | "desc") {
  const sortRaw = c.req.query("sort") ?? "created";
  const sort: "created" | "updated" = sortRaw === "updated" ? "updated" : "created";
  const dirRaw = c.req.query("direction");
  const direction: "asc" | "desc" = dirRaw === "desc" ? "desc" : dirRaw === "asc" ? "asc" : defaultDirection;
  return { sort, direction };
}

function adjustIssueCommentCount(gh: GitHubStore, issue: GitHubIssue, delta: number) {
  gh.issues.update(issue.id, { comments: Math.max(0, issue.comments + delta) });
}

function adjustPrReviewCommentCount(gh: GitHubStore, pr: GitHubPullRequest, delta: number) {
  gh.pullRequests.update(pr.id, { review_comments: Math.max(0, pr.review_comments + delta) });
}

function reviewDiffContainsLine(patch: string | undefined, line: unknown, side: unknown): boolean {
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return false;
  for (const hunk of (patch ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const offset = side === "LEFT" ? 1 : 3;
    const start = Number(hunk[offset]);
    const count = Number(hunk[offset + 1] ?? 1);
    if (line >= start && line < start + count) return true;
  }
  return false;
}

export function validateReviewCommentLocation(
  gh: GitHubStore,
  pr: GitHubPullRequest,
  commitSha: string,
  path: string | null,
  raw: Record<string, unknown>,
): void {
  const base = findCommitBySha(gh, pr.repo_id, pr.base_sha);
  const head = findCommitBySha(gh, pr.head_repo_id, commitSha);
  if (!base || !head || path === null) throw new ApiError(422, "Validation failed");
  const before = flattenTree(gh, pr.repo_id, base.tree_sha).blobs.get(path);
  const after = flattenTree(gh, pr.head_repo_id, head.tree_sha).blobs.get(path);
  if ((!before && !after) || before?.sha === after?.sha) {
    throw new ApiError(422, "Path is not part of the pull request diff");
  }
  if (raw.subject_type === "file") return;
  const oldText = before ? blobText(gh, pr.repo_id, before.sha) : "";
  const newText = after ? blobText(gh, pr.head_repo_id, after.sha) : "";
  const patch = oldText !== null && newText !== null ? diffText(oldText, newText).patch : undefined;
  if (raw.position !== undefined) return;
  if (
    !reviewDiffContainsLine(patch, raw.line, raw.side) ||
    (raw.start_line !== undefined && !reviewDiffContainsLine(patch, raw.start_line, raw.start_side))
  ) {
    throw new ApiError(422, "Line is not part of the pull request diff");
  }
}

export function commentsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  // --- Issue comments: specific paths before /issues/:issue_number/comments ---

  app.get("/repos/:owner/:repo/issues/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);
    if (!repo.has_issues) throw notFoundResponse();

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "issue");
    if (!comment) throw notFoundResponse();

    const json = formatComment(comment, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.patch("/repos/:owner/:repo/issues/comments/:comment_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    let comment = getCommentForRepo(gh, repo, commentId, "issue");
    if (!comment) throw notFoundResponse();

    const body = await parseJsonBody(c);
    if (typeof body.body !== "string") {
      throw new ApiError(422, "Validation failed");
    }

    comment = gh.comments.update(comment.id, { body: body.body })!;
    const issue = comment.issue_number !== null ? findIssueByNumber(gh, repo.id, comment.issue_number) : undefined;
    const ownerLogin = ownerLoginOf(gh, repo);
    const issueFmt = issue ? formatIssue(issue, gh, baseUrl) : null;
    const commentFmt = formatComment(comment, gh, baseUrl);
    if (!commentFmt) throw notFoundResponse();

    webhooks.dispatch(
      "issue_comment",
      "edited",
      {
        action: "edited",
        comment: commentFmt,
        issue: issueFmt,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );

    return c.json(commentFmt);
  });

  app.delete("/repos/:owner/:repo/issues/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "issue");
    if (!comment) throw notFoundResponse();

    const issue = comment.issue_number !== null ? findIssueByNumber(gh, repo.id, comment.issue_number) : undefined;
    const commentFmt = formatComment(comment, gh, baseUrl);
    const issueFmt = issue ? formatIssue(issue, gh, baseUrl) : null;
    const ownerLogin = ownerLoginOf(gh, repo);

    gh.comments.delete(comment.id);
    for (const reaction of gh.reactions.findBy("subject_id", comment.id)) {
      if (reaction.subject_type === "issue_comment") gh.reactions.delete(reaction.id);
    }
    if (issue) adjustIssueCommentCount(gh, issue, -1);

    webhooks.dispatch(
      "issue_comment",
      "deleted",
      {
        action: "deleted",
        comment: commentFmt,
        issue: issueFmt,
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );

    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/issues/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);
    if (!repo.has_issues) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");
    const since = c.req.query("since");

    let list = gh.comments.findBy("repo_id", repo.id).filter((x) => x.comment_type === "issue");
    if (since) {
      list = list.filter((x) => x.updated_at >= since);
    }
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  // --- Pull review comments ---

  app.get("/repos/:owner/:repo/pulls/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "review");
    if (!comment) throw notFoundResponse();

    const review = comment.review_id ? gh.reviews.get(comment.review_id) : undefined;
    const auth = c.get("authUser");
    if (review?.state === "PENDING" && (!auth || getActorUser(gh, auth)?.id !== review.user_id))
      throw notFoundResponse();

    const json = formatComment(comment, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.patch("/repos/:owner/:repo/pulls/comments/:comment_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    let comment = getCommentForRepo(gh, repo, commentId, "review");
    if (!comment) throw notFoundResponse();

    const body = await parseJsonBody(c);
    if (typeof body.body !== "string") {
      throw new ApiError(422, "Validation failed");
    }

    comment = gh.comments.update(comment.id, { body: body.body })!;
    const pr = comment.pull_number !== null ? findPull(gh, repo.id, comment.pull_number) : undefined;
    const ownerLogin = ownerLoginOf(gh, repo);
    const commentFmt = formatComment(comment, gh, baseUrl);
    if (!commentFmt) throw notFoundResponse();

    if (!comment.review_id || gh.reviews.get(comment.review_id)?.state !== "PENDING")
      webhooks.dispatch(
        "pull_request_review_comment",
        "edited",
        {
          action: "edited",
          comment: commentFmt,
          pull_request: pr ? formatPullRequest(pr, gh, baseUrl) : null,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name,
      );

    return c.json(commentFmt);
  });

  app.delete("/repos/:owner/:repo/pulls/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "review");
    if (!comment) throw notFoundResponse();

    const pr = comment.pull_number !== null ? findPull(gh, repo.id, comment.pull_number) : undefined;
    const commentFmt = formatComment(comment, gh, baseUrl);
    const ownerLogin = ownerLoginOf(gh, repo);

    gh.comments.delete(comment.id);
    for (const reaction of gh.reactions.findBy("subject_id", comment.id)) {
      if (reaction.subject_type === "review_comment") gh.reactions.delete(reaction.id);
    }
    if (pr) adjustPrReviewCommentCount(gh, pr, -1);

    if (!comment.review_id || gh.reviews.get(comment.review_id)?.state !== "PENDING")
      webhooks.dispatch(
        "pull_request_review_comment",
        "deleted",
        {
          action: "deleted",
          comment: commentFmt,
          pull_request: pr ? formatPullRequest(pr, gh, baseUrl) : null,
          repository: formatRepo(repo, gh, baseUrl),
          sender: formatUser(actor, baseUrl),
        },
        ownerLogin,
        repo.name,
      );

    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/pulls/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    const auth = c.get("authUser");
    const viewer = auth ? getActorUser(gh, auth) : undefined;
    let list = gh.comments.findBy("repo_id", repo.id).filter((comment) => {
      if (comment.comment_type !== "review") return false;
      const review = comment.review_id ? gh.reviews.get(comment.review_id) : undefined;
      return review?.state !== "PENDING" || review.user_id === viewer?.id;
    });
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  // --- Commit comments (repo scope) ---

  app.get("/repos/:owner/:repo/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "commit");
    if (!comment) throw notFoundResponse();

    const json = formatComment(comment, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.patch("/repos/:owner/:repo/comments/:comment_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    assertRepoWrite(gh, c.get("authUser"), repo, "contents");

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    let comment = getCommentForRepo(gh, repo, commentId, "commit");
    if (!comment) throw notFoundResponse();

    const body = await parseJsonBody(c);
    if (typeof body.body !== "string") {
      throw new ApiError(422, "Validation failed");
    }

    comment = gh.comments.update(comment.id, { body: body.body })!;
    const json = formatComment(comment, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.delete("/repos/:owner/:repo/comments/:comment_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    assertRepoWrite(gh, c.get("authUser"), repo, "contents");

    const commentId = parseInt(c.req.param("comment_id")!, 10);
    if (!Number.isFinite(commentId)) throw notFoundResponse();

    const comment = getCommentForRepo(gh, repo, commentId, "commit");
    if (!comment) throw notFoundResponse();

    gh.comments.delete(comment.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    let list = gh.comments.findBy("repo_id", repo.id).filter((x) => x.comment_type === "commit");
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  // --- Per-issue / per-PR / per-commit ---

  app.get("/repos/:owner/:repo/issues/:issue_number/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);
    if (!repo.has_issues) throw notFoundResponse();

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    let list = gh.comments
      .findBy("repo_id", repo.id)
      .filter((x) => x.comment_type === "issue" && x.issue_number === issueNumber);
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  app.post("/repos/:owner/:repo/issues/:issue_number/comments", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    if (!repo.has_issues) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, ["issues", "pull_requests"]);

    const issueNumber = parseInt(c.req.param("issue_number")!, 10);
    if (!Number.isFinite(issueNumber)) throw notFoundResponse();

    const issue = findIssueByNumber(gh, repo.id, issueNumber);
    if (!issue) throw notFoundResponse();

    const raw = await parseJsonBody(c);
    if (typeof raw.body !== "string" || !raw.body.trim()) {
      throw new ApiError(422, "Validation failed");
    }

    const row = gh.comments.insert({
      node_id: "",
      repo_id: repo.id,
      issue_number: issueNumber,
      pull_number: null,
      commit_sha: null,
      body: raw.body,
      user_id: actor.id,
      in_reply_to_id: null,
      path: null,
      position: null,
      line: null,
      side: null,
      subject_type: null,
      comment_type: "issue",
      review_id: null,
    } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
    gh.comments.update(row.id, { node_id: generateNodeId("IssueComment", row.id) });
    const comment = gh.comments.get(row.id)!;

    adjustIssueCommentCount(gh, issue, 1);

    const ownerLogin = ownerLoginOf(gh, repo);
    const commentFmt = formatComment(comment, gh, baseUrl)!;

    webhooks.dispatch(
      "issue_comment",
      "created",
      {
        action: "created",
        comment: commentFmt,
        issue: formatIssue(issue, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );

    return c.json(commentFmt, 201);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    let list = gh.comments
      .findBy("repo_id", repo.id)
      .filter(
        (x) =>
          x.comment_type === "review" &&
          x.pull_number === pullNumber &&
          (!x.review_id || gh.reviews.get(x.review_id)?.state !== "PENDING"),
      );
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  const createReviewComment = async (c: Context) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const raw = await parseJsonBody(c);
    if (typeof raw.body !== "string" || !raw.body.trim()) {
      throw new ApiError(422, "Validation failed");
    }

    const commitSha = typeof raw.commit_id === "string" && raw.commit_id.trim() ? raw.commit_id.trim() : pr.head_sha;

    let inReplyTo: number | null = null;
    let parent: GitHubComment | undefined;
    const replyId = (c.req.param("comment_id") || undefined) ?? raw.in_reply_to ?? raw.in_reply_to_id;
    if (replyId !== undefined && replyId !== null) {
      const rid = typeof replyId === "number" ? replyId : parseInt(String(replyId), 10);
      if (!Number.isFinite(rid)) throw new ApiError(422, "Validation failed");
      parent = gh.comments.get(rid);
      if (
        !parent ||
        parent.repo_id !== repo.id ||
        parent.comment_type !== "review" ||
        parent.pull_number !== pullNumber ||
        parent.in_reply_to_id !== null
      ) {
        throw new ApiError(422, "Validation failed");
      }
      inReplyTo = rid;
    }

    const pathVal = raw.path === undefined || raw.path === null ? null : typeof raw.path === "string" ? raw.path : null;
    const position =
      raw.position === undefined || raw.position === null
        ? null
        : typeof raw.position === "number" && Number.isFinite(raw.position)
          ? raw.position
          : parseInt(String(raw.position), 10);
    const line =
      raw.line === undefined || raw.line === null
        ? null
        : typeof raw.line === "number" && Number.isFinite(raw.line)
          ? raw.line
          : parseInt(String(raw.line), 10);
    let side: "LEFT" | "RIGHT" | null = null;
    if (raw.side === "LEFT" || raw.side === "RIGHT") side = raw.side;
    else if (raw.side === null || raw.side === undefined) side = null;
    else throw new ApiError(422, "Validation failed");

    let subjectType: "line" | "file" | null = null;
    if (raw.subject_type === "line" || raw.subject_type === "file") subjectType = raw.subject_type;
    else if (raw.subject_type === null || raw.subject_type === undefined) subjectType = null;
    else throw new ApiError(422, "Validation failed");

    if (position !== null && !Number.isFinite(position)) throw new ApiError(422, "Validation failed");
    if (line !== null && !Number.isFinite(line)) throw new ApiError(422, "Validation failed");

    if (inReplyTo === null) validateReviewCommentLocation(gh, pr, commitSha, pathVal, raw);

    const row = gh.comments.insert({
      node_id: "",
      repo_id: repo.id,
      issue_number: null,
      pull_number: pullNumber,
      commit_sha: parent?.commit_sha ?? commitSha,
      body: raw.body,
      user_id: actor.id,
      in_reply_to_id: inReplyTo,
      path: parent?.path ?? pathVal,
      position: parent?.position ?? (position !== null && Number.isFinite(position) ? position : null),
      line: parent?.line ?? (line !== null && Number.isFinite(line) ? line : null),
      side: parent?.side ?? side,
      subject_type: parent?.subject_type ?? subjectType,
      comment_type: "review",
      review_id: null,
    } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
    gh.comments.update(row.id, { node_id: generateNodeId("PullRequestReviewComment", row.id) });
    const comment = gh.comments.get(row.id)!;

    adjustPrReviewCommentCount(gh, pr, 1);

    const ownerLogin = ownerLoginOf(gh, repo);
    const commentFmt = formatComment(comment, gh, baseUrl)!;

    webhooks.dispatch(
      "pull_request_review_comment",
      "created",
      {
        action: "created",
        comment: commentFmt,
        pull_request: formatPullRequest(pr, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );

    return c.json(commentFmt, 201);
  };
  app.post("/repos/:owner/:repo/pulls/:pull_number/comments", createReviewComment);
  app.post("/repos/:owner/:repo/pulls/:pull_number/comments/:comment_id/replies", createReviewComment);

  app.get("/repos/:owner/:repo/commits/:commit_sha/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoContentsRead(gh, c.get("authUser"), repo);

    const commitSha = c.req.param("commit_sha")!;
    const commit = findCommitInRepo(gh, repo.id, commitSha);
    if (!commit) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    let list = gh.comments
      .findBy("repo_id", repo.id)
      .filter((x) => x.comment_type === "commit" && x.commit_sha === commit.sha);
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  app.post("/repos/:owner/:repo/commits/:commit_sha/comments", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "contents");

    const commitShaParam = c.req.param("commit_sha")!;
    const commit = findCommitInRepo(gh, repo.id, commitShaParam);
    if (!commit) throw notFoundResponse();

    const raw = await parseJsonBody(c);
    if (typeof raw.body !== "string" || !raw.body.trim()) {
      throw new ApiError(422, "Validation failed");
    }

    const pathVal = raw.path === undefined || raw.path === null ? null : typeof raw.path === "string" ? raw.path : null;
    const position =
      raw.position === undefined || raw.position === null
        ? null
        : typeof raw.position === "number" && Number.isFinite(raw.position)
          ? raw.position
          : parseInt(String(raw.position), 10);
    const line =
      raw.line === undefined || raw.line === null
        ? null
        : typeof raw.line === "number" && Number.isFinite(raw.line)
          ? raw.line
          : parseInt(String(raw.line), 10);

    if (position !== null && !Number.isFinite(position)) throw new ApiError(422, "Validation failed");
    if (line !== null && !Number.isFinite(line)) throw new ApiError(422, "Validation failed");

    const row = gh.comments.insert({
      node_id: "",
      repo_id: repo.id,
      issue_number: null,
      pull_number: null,
      commit_sha: commit.sha,
      body: raw.body,
      user_id: actor.id,
      in_reply_to_id: null,
      path: pathVal,
      position: position !== null && Number.isFinite(position) ? position : null,
      line: line !== null && Number.isFinite(line) ? line : null,
      side: null,
      subject_type: null,
      comment_type: "commit",
      review_id: null,
    } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
    gh.comments.update(row.id, { node_id: generateNodeId("CommitComment", row.id) });
    const comment = gh.comments.get(row.id)!;

    const commentFmt = formatComment(comment, gh, baseUrl)!;
    return c.json(commentFmt, 201);
  });
}
